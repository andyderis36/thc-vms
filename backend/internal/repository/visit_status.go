package repository

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// UpdateStatus moves one visit to status and appends its history row in ONE
// transaction: lock via GetVisitByIDForUpdate, write via UpdateVisitStatus,
// audit via InsertStatusHistory. changed_by is SQL NULL when changedBy is the
// empty UUID (automatic transitions). Any failure rolls everything back, so a
// status change without its history row (or the reverse) is impossible.
//
// A move onto the status the visit already holds is refused with ErrConflict:
// the row lock serialises two concurrent approvals, the loser sees the fresh
// status and must not append a second history row for a transition that
// already happened.
func (r *visitRepository) UpdateStatus(
	ctx context.Context,
	id domain.UUID,
	status domain.VisitStatus,
	changedBy domain.UUID,
	notes string,
) error {
	if _, err := domain.ParseVisitStatus(string(status)); err != nil {
		return err
	}
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	actor, err := pgNullUUID(changedBy)
	if err != nil {
		return err
	}
	var pending *pendingEmail
	var locationID, vendorUserID uuid.UUID
	// skippedGateEntry carries the visit code of a gate edge whose email leg
	// the frugal rule suppressed, so the skip is logged only after the
	// transaction commits. An empty code means no skip to report.
	var skippedGateEntry string
	snap := domain.DefaultNotificationSettings()
	if r.settingsLoader != nil {
		if loaded, err := r.settingsLoader.LoadNotificationSettings(ctx); err == nil {
			snap = loaded
		}
	}
	if err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		locked, err := q.GetVisitByIDForUpdate(ctx, db.GetVisitByIDForUpdateParams{ID: parsed})
		if err != nil {
			return MapError(err)
		}
		if locked.Status == string(status) {
			return fmt.Errorf("repository: visit %s already %s: %w", id, status, domain.ErrConflict)
		}
		// Gate entries travel the multi-entry state machine; ResolveGateTransition
		// is the single guard for its three edges and refuses terminal exits and
		// same-direction double scans. Non-gate moves keep the direct write.
		direction := gateDirection(status)
		firstEntry := false
		if direction != "" {
			action := domain.GateActionCheckIn
			if direction == "out" {
				action = domain.GateActionCheckOut
			}
			current := domain.VisitStatus(locked.Status)
			if _, ok := domain.ResolveGateTransition(current, action); !ok {
				return domain.NewInvalidTransition(current, status)
			}
			if direction == "in" {
				firstEntry, err = isFirstCheckIn(ctx, q, parsed)
				if err != nil {
					return err
				}
			}
		}
		if _, err := q.UpdateVisitStatus(ctx, db.UpdateVisitStatusParams{
			ID:     parsed,
			Status: string(status),
		}); err != nil {
			return MapError(err)
		}
		if _, err := q.InsertStatusHistory(ctx, db.InsertStatusHistoryParams{
			VisitRequestID: parsed,
			Status:         string(status),
			ChangedBy:      actor,
			Notes:          pgText(notePtr(notes)),
		}); err != nil {
			return MapError(err)
		}
		// One visit_logs row per gate entry, written in this same transaction:
		// a status edge can never exist without its timeline row (or the
		// reverse). A failure here rolls back the status and history writes.
		if direction != "" {
			role, err := resolveActorRole(ctx, tx, changedBy)
			if err != nil {
				return err
			}
			if _, err := q.InsertVisitLog(ctx, db.InsertVisitLogParams{
				VisitRequestID: parsed,
				Direction:      direction,
				ActorUserID:    actor,
				ActorRole:      role,
			}); err != nil {
				return MapError(err)
			}
		}
		locationID, vendorUserID = locked.LocationID, locked.VendorUserID
		// Resolve the email actor rows inside the tx: who filed the request
		// (created_by) and, for a human transition, who performs it. A
		// system transition resolves no actor and the email omits the row.
		changer, _ := fromDomainUUID(changedBy)
		actors := resolveEmailActors(ctx, tx, locked, changer)
		first := domain.TransitionNotification(status, !actor.Valid, locked.VisitID, notes)
		if err := emit(ctx, q, first, locked.ID, locked.LocationID, locked.VendorUserID, time.Now(), snap); err != nil {
			return err
		}
		// A human-driven cancellation notifies the other side: the vendor
		// cancelling its own visit tells the branch staff, an admin or
		// superadmin cancelling tells the vendor. A system-driven cancel
		// (empty actor, SQL NULL) notifies both: the vendor row from the emit
		// above plus the staff row emitted below, fanned out over one email
		// each. byVendor compares the actor against the visit's vendor user:
		// only the owning vendor may cancel via the usecase guard, so
		// equality means a vendor-side cancel. The message names the person
		// (name + Indonesian role label), falling back to the role word only
		// when the user row could not be resolved.
		if status == domain.VisitStatusCancelled && actor.Valid {
			changer, _ := fromDomainUUID(changedBy)
			byVendor := changer == locked.VendorUserID
			human := domain.HumanCancelledNotification(locked.VisitID, byVendor, domain.ActorLine(actors.actorName, actors.actorRole))
			if err := emit(ctx, q, human, locked.ID, locked.LocationID, locked.VendorUserID, time.Now(), snap); err != nil {
				return err
			}
			pending = &pendingEmail{visit: actors.apply(emailVisit(locked, locked.StartDate, locked.EndDate, notes)), tpl: human, audiences: []domain.NotificationAudience{human.Audience}}
		}
		var staffAuto *domain.NotificationTemplate
		if status == domain.VisitStatusCancelled && !actor.Valid {
			staffAuto = domain.AutoCancelledStaffNotification(locked.VisitID)
			if err := emit(ctx, q, staffAuto, locked.ID, locked.LocationID, locked.VendorUserID, time.Now(), snap); err != nil {
				return err
			}
		}
		if first != nil {
			// Multi-entry permits are frugal with mail: ONLY the first
			// check-in and the final completion send email. Intermediate gate
			// edges (a re-entry check-in or an intermediate check-out) already
			// wrote their in-app bell and visit_logs row above, but skip the
			// email leg so one permit cannot mail on every turnstile pass.
			// Non-gate transitions keep mailing exactly as before.
			mailNow := direction == "" || (direction == "in" && firstEntry)
			if !mailNow {
				skippedGateEntry = locked.VisitID
			} else {
				v := actors.apply(emailVisit(locked, locked.StartDate, locked.EndDate, notes))
				audiences := []domain.NotificationAudience{first.Audience}
				if staffAuto != nil {
					audiences = append(audiences, staffAuto.Audience)
				}
				if status == domain.VisitStatusCompleted && !actor.Valid {
					name, role := domain.SystemActorName, domain.SystemActorRole
					v.ActorName, v.ActorRoleLabel = &name, &role
				}
				if status == domain.VisitStatusVisiting {
					now := time.Now()
					v.CheckInAt = &now
					if actor.Valid {
						cb := changedBy
						v.CheckedInBy = &cb
					}
				}
				// Check-out is now the offsite edge; a system completion (R3)
				// still carries the check-out timestamp with the System actor
				// pinned above, so both legs keep their existing email shape.
				if status == domain.VisitStatusOffsite || status == domain.VisitStatusCompleted {
					now := time.Now()
					v.CheckOutAt = &now
					if actor.Valid {
						cb := changedBy
						v.CheckedOutBy = &cb
					}
				}
				pending = &pendingEmail{visit: v, tpl: first, audiences: audiences}
			}
		}
		// Load the roster for every pending email so check-in/out (and other)
		// notices can carry the visitor/team names. A roster read failure
		// fails the write like any other in-transaction storage error.
		if pending != nil {
			if err := attachMembers(ctx, q, parsed, pending); err != nil {
				return err
			}
			if err := attachPurposes(ctx, q, parsed, pending); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	// The transaction committed: fan the single captured email out. A
	// rolled-back transaction returns above with no pending email, so it
	// enqueues zero. enqueueEmail itself never fails the caller.
	if pending != nil {
		enqueueEmail(ctx, r.mailer, db.New(r.pool), pending.visit, pending.tpl, locationID, vendorUserID, r.frontendBaseURL, snap, pending.audiences...)
	} else if skippedGateEntry != "" {
		slog.Info("email skipped: intermediate gate entry (in-app bell and visit_logs row written)",
			"visit_id", skippedGateEntry, "status", string(status))
	}
	return nil
}

// Reschedule writes the new window, flips the status to rescheduled and
// appends the history row atomically; reason is stored as the history note.
// A reversed window is rejected by the database CHECK as well as by request
// validation, and the rollback keeps the old window intact.
func (r *visitRepository) Reschedule(
	ctx context.Context,
	id domain.UUID,
	start time.Time,
	end time.Time,
	changedBy domain.UUID,
	reason string,
) error {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return err
	}
	actor, err := pgNullUUID(changedBy)
	if err != nil {
		return err
	}
	var pending *pendingEmail
	var locationID, vendorUserID uuid.UUID
	snap := domain.DefaultNotificationSettings()
	if r.settingsLoader != nil {
		if loaded, err := r.settingsLoader.LoadNotificationSettings(ctx); err == nil {
			snap = loaded
		}
	}
	if err := WithTx(ctx, r.pool, func(tx pgx.Tx) error {
		q := db.New(r.pool).WithTx(tx)
		locked, err := q.GetVisitByIDForUpdate(ctx, db.GetVisitByIDForUpdateParams{ID: parsed})
		if err != nil {
			return MapError(err)
		}
		if _, err := q.UpdateVisitSchedule(ctx, db.UpdateVisitScheduleParams{
			ID:        parsed,
			StartDate: start,
			EndDate:   end,
			Status:    string(domain.VisitStatusRescheduled),
		}); err != nil {
			return MapError(err)
		}
		if _, err := q.InsertStatusHistory(ctx, db.InsertStatusHistoryParams{
			VisitRequestID: parsed,
			Status:         string(domain.VisitStatusRescheduled),
			ChangedBy:      actor,
			Notes:          pgText(notePtr(reason)),
		}); err != nil {
			return MapError(err)
		}
		locationID, vendorUserID = locked.LocationID, locked.VendorUserID
		rescheduleChanger, _ := fromDomainUUID(changedBy)
		actors := resolveEmailActors(ctx, tx, locked, rescheduleChanger)
		staffTpl := domain.TransitionNotification(domain.VisitStatusRescheduled, false, locked.VisitID, reason)
		if err := emit(ctx, q, staffTpl, locked.ID, locked.LocationID, locked.VendorUserID, time.Now(), snap); err != nil {
			return err
		}
		// Every reschedule also notifies the vendor with the same
		// visit_rescheduled type. The staff row above and this vendor row
		// address disjoint recipient sets, and a repeat reschedule collapses
		// on the store's unique constraint, so the dual emit is idempotent
		// without actor branching.
		vendorTpl := domain.RescheduledVendorNotification(locked.VisitID, reason)
		if err := emit(ctx, q, vendorTpl, locked.ID, locked.LocationID, locked.VendorUserID, time.Now(), snap); err != nil {
			return err
		}
		// The dual in_app emit collapses to ONE email over the union of both
		// audiences: the two templates carry the same type and copy, so one
		// BuildEmail renders both.
		pending = &pendingEmail{
			visit:     actors.apply(emailVisit(locked, start, end, reason)),
			tpl:       staffTpl,
			audiences: []domain.NotificationAudience{staffTpl.Audience, vendorTpl.Audience},
		}
		if err := attachMembers(ctx, q, parsed, pending); err != nil {
			return err
		}
		if err := attachPurposes(ctx, q, parsed, pending); err != nil {
			return err
		}
		return nil
	}); err != nil {
		return err
	}
	if pending != nil {
		enqueueEmail(ctx, r.mailer, db.New(r.pool), pending.visit, pending.tpl, locationID, vendorUserID, r.frontendBaseURL, snap, pending.audiences...)
	}
	return nil
}

// emailVisit projects the locked row onto the BuildEmail context: the visit
// code, the location, the schedule the notice is about, the company/purpose/
// notes context rows, and the actor's note as the reason row (omitted when
// blank).
func emailVisit(locked db.GetVisitByIDForUpdateRow, start, end time.Time, note string) domain.VisitRequest {
	visit := domain.VisitRequest{
		VisitID:      locked.VisitID,
		LocationName: locked.LocationName,
		StartDate:    start,
		EndDate:      end,
		VendorName:   emailCompany(locked),
		Notes:        textPtr(locked.Notes),
		PurposeNote:  textPtr(locked.PurposeNote),
	}
	if strings.TrimSpace(note) != "" {
		visit.StatusNote = notePtr(note)
	}
	return visit
}

// emailCompany resolves the Vendor/Perusahaan row: the visit-level manual
// override first, then the requesting account's own company, then the visit's
// catalogue vendor; "" when none is set so the row is omitted.
func emailCompany(locked db.GetVisitByIDForUpdateRow) string {
	override, catalogue := textPtr(locked.VendorNameOverride), textPtr(locked.VendorName)
	for _, candidate := range []*string{override, &locked.VendorUserVendorName, catalogue} {
		if candidate == nil {
			continue
		}
		if trimmed := strings.TrimSpace(*candidate); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// emailActors carries the display data resolved for the email actor rows:
// the created_by requester and the acting user of a human transition. Empty
// strings mean "unresolved" and render as an omitted row, never a bare UUID.
type emailActors struct {
	createdName, createdRole string
	actorName, actorRole     string
}

// apply pins the resolved actor rows onto the email context.
func (a emailActors) apply(v domain.VisitRequest) domain.VisitRequest {
	if a.createdName != "" {
		n := a.createdName
		v.CreatedByName = &n
	}
	if a.createdRole != "" {
		r := a.createdRole
		v.CreatedByRoleLabel = &r
	}
	if a.actorName != "" {
		n := a.actorName
		v.ActorName = &n
	}
	if a.actorRole != "" {
		r := a.actorRole
		v.ActorRoleLabel = &r
	}
	return v
}

// resolveEmailActors resolves the actor-row display data inside the open
// status-write transaction: the created_by requester always, plus the acting
// user when changer is a real user (uuid.Nil means a system transition). A
// missing user row yields empty strings so the email omits the row instead
// of printing a bare UUID.
func resolveEmailActors(ctx context.Context, tx pgx.Tx, locked db.GetVisitByIDForUpdateRow, changer uuid.UUID) emailActors {
	var a emailActors
	if locked.CreatedBy.Valid {
		a.createdName, a.createdRole = resolveUserDisplay(ctx, tx, uuid.UUID(locked.CreatedBy.Bytes))
	}
	if changer != uuid.Nil {
		a.actorName, a.actorRole = resolveUserDisplay(ctx, tx, changer)
	}
	return a
}

// resolveUserDisplay looks up one user's display name and Indonesian role
// label in one query. A missing row or any error yields two empty strings so
// callers omit the actor row instead of printing a bare UUID.
func resolveUserDisplay(ctx context.Context, tx pgx.Tx, id uuid.UUID) (string, string) {
	var name, role string
	if err := tx.QueryRow(ctx,
		`SELECT u.name, r.name FROM users u JOIN role r ON r.id = u.role_id WHERE u.id = $1`, id,
	).Scan(&name, &role); err != nil {
		return "", ""
	}
	return strings.TrimSpace(name), domain.RoleLabel(role)
}

// resolveUserName looks up the display name for an actor UUID. A missing row
// or any query error yields "" so callers fall back to the UUID string.
func resolveUserName(ctx context.Context, q *db.Queries, id domain.UUID) (string, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return "", err
	}
	row, err := q.GetUserByID(ctx, db.GetUserByIDParams{ID: parsed})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(row.Name), nil
}

// gateDirection maps a gate target status to its visit_logs direction. Every
// other status returns "" and is not a per-entry event.
func gateDirection(status domain.VisitStatus) string {
	switch status {
	case domain.VisitStatusVisiting:
		return "in"
	case domain.VisitStatusOffsite:
		return "out"
	default:
		return ""
	}
}

// isFirstCheckIn reports whether the 'in' row about to be written is the
// visit's first gate entry: no earlier 'in' row exists in visit_logs. The read
// runs inside the status-write transaction BEFORE the new row is inserted, so
// it sees only prior entries. visit_logs is the source of truth for the frugal
// email rule - only a first check-in mails. A read failure is a storage error
// and rolls the status write back like any other in-transaction read.
func isFirstCheckIn(ctx context.Context, q *db.Queries, visitID uuid.UUID) (bool, error) {
	rows, err := q.ListVisitLogsByVisit(ctx, db.ListVisitLogsByVisitParams{VisitRequestID: visitID})
	if err != nil {
		return false, MapError(err)
	}
	for _, row := range rows {
		if row.Direction == "in" {
			return false, nil
		}
	}
	return true, nil
}

// resolveActorRole resolves the acting user's raw role name for the visit_logs
// audit row. An empty (system) actor stores SQL NULL; a missing user or role is
// a storage error and rolls the status write back, matching the actor_user_id
// foreign key on visit_logs.
func resolveActorRole(ctx context.Context, tx pgx.Tx, changer domain.UUID) (pgtype.Text, error) {
	if changer == "" {
		return pgtype.Text{}, nil
	}
	parsed, err := fromDomainUUID(changer)
	if err != nil {
		return pgtype.Text{}, err
	}
	var role string
	if err := tx.QueryRow(ctx,
		`SELECT r.name FROM users u JOIN role r ON r.id = u.role_id WHERE u.id = $1`, parsed,
	).Scan(&role); err != nil {
		return pgtype.Text{}, MapError(err)
	}
	return pgText(&role), nil
}

// notePtr maps an empty note to NULL so history rows carry a note only when
// the actor actually wrote one.
func notePtr(note string) *string {
	if note == "" {
		return nil
	}
	return &note
}
