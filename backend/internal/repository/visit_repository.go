package repository

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/repository/db"
)

// visitRepository is the PostgreSQL adapter for domain.VisitRepository.
// The port is split across files by responsibility: this file owns creation
// and single-row reads, visit_list.go owns scoped pagination, visit_status.go
// owns atomic transitions, and visit_mapping.go owns row projections.
type visitRepository struct {
	pool *pgxpool.Pool
	// mailer is the outbound email port, wired after construction via
	// WithMailer mirroring the visit usecase. It is OPTIONAL: nil only
	// disables email fan-out, it never fails a write. The SMTP transport
	// stays in infrastructure; the adapter is only ever Send-queued.
	mailer domain.Mailer
	// frontendBaseURL is the public web origin used to render absolute deep
	// links in lifecycle emails (WithFrontendBaseURL, mirroring WithMailer).
	// Empty keeps the legacy relative links.
	frontendBaseURL string
	// settingsLoader is the optional notification-settings port. nil means
	// default-Active (today's behaviour).
	settingsLoader domain.SettingsLoader
}

// Compile-time proof that the adapter satisfies its port.
var _ domain.VisitRepository = (*visitRepository)(nil)

// NewVisitRepository builds the PostgreSQL-backed visit repository. The
// concrete type is returned so the composition root can chain WithMailer;
// it still satisfies domain.VisitRepository wherever the port is taken.
func NewVisitRepository(pool *pgxpool.Pool) *visitRepository {
	return &visitRepository{pool: pool}
}

// WithMailer wires the outbound email port and returns the repository for
// chaining at the composition root, mirroring the visit usecase. A nil mailer
// only disables email fan-out, it never fails a write.
func (r *visitRepository) WithMailer(mailer domain.Mailer) *visitRepository {
	r.mailer = mailer
	return r
}

// WithFrontendBaseURL wires the public web origin used for absolute deep links
// in lifecycle emails and returns the repository for chaining at the composition
// root, mirroring WithMailer. An empty value keeps the legacy relative links.
func (r *visitRepository) WithFrontendBaseURL(base string) *visitRepository {
	r.frontendBaseURL = strings.TrimSpace(base)
	return r
}

// WithSettings wires the notification-settings loader used to gate emissions.
func (r *visitRepository) WithSettings(loader domain.SettingsLoader) *visitRepository {
	r.settingsLoader = loader
	return r
}

// visitCodeAttempts caps the VST-code regeneration loop on a code clash.
const visitCodeAttempts = 5

// Create persists a visit request with its visitors and purpose links in ONE
// transaction. The human visit code is minted here as VST- + 10 digits (the
// chk_visit_request_visit_id_format shape); a clash regenerates the code and
// retries the whole transaction. No status_history row is written: the visit
// is born 'requested' and its first history row belongs to its first explicit
// transition, so the atomicity tests can assert exactly one row per UpdateStatus.
func (r *visitRepository) Create(
	ctx context.Context,
	visit domain.VisitRequest,
	visitors []domain.Visitor,
	purposeIDs []domain.UUID,
) (domain.VisitRequest, error) {
	vendorUserID, err := fromDomainUUID(visit.VendorUserID)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	locationID, err := fromDomainUUID(visit.LocationID)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	vendorID, err := pgNullUUID(visit.VendorID)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	createdBy, err := pgNullUUIDPtr(visit.CreatedBy)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	purposes := make([]uuid.UUID, 0, len(purposeIDs))
	for _, id := range purposeIDs {
		parsed, err := fromDomainUUID(id)
		if err != nil {
			return domain.VisitRequest{}, err
		}
		purposes = append(purposes, parsed)
	}

	var created db.VisitRequest
	var lastErr error
	snap := domain.DefaultNotificationSettings()
	if r.settingsLoader != nil {
		if loaded, err := r.settingsLoader.LoadNotificationSettings(ctx); err == nil {
			snap = loaded
		}
	}
	for range visitCodeAttempts {
		code, err := genVisitCode()
		if err != nil {
			return domain.VisitRequest{}, err
		}
		err = WithTx(ctx, r.pool, func(tx pgx.Tx) error {
			q := db.New(r.pool).WithTx(tx)
			row, err := q.CreateVisit(ctx, db.CreateVisitParams{
				VisitID:             code,
				VendorUserID:        vendorUserID,
				VendorID:            vendorID,
				LocationID:          locationID,
				StartDate:           visit.StartDate,
				EndDate:             visit.EndDate,
				IsMultiDay:          visit.IsMultiDay,
				AssignmentLetterUrl: pgText(visit.AssignmentLetterURL),
				IsNdaAccepted:       visit.IsNDAAccepted,
				Notes:               pgText(visit.Notes),
				PurposeNote:         pgText(visit.PurposeNote),
				VendorNameOverride:  pgText(visit.VendorNameOverride),
				CreatedBy:           createdBy,
			})
			if err != nil {
				return MapError(err)
			}
			for _, v := range visitors {
				vendorID, err := pgNullUUID(v.VendorID)
				if err != nil {
					return MapError(err)
				}
				if _, err := q.InsertVisitor(ctx, db.InsertVisitorParams{
					VisitRequestID:     row.ID,
					Name:               v.Name,
					IDNumber:           v.IDNumber,
					Phone:              v.Phone,
					IDCardPhotoUrl:     pgText(v.IDCardPhotoURL),
					PhotoUrl:           pgText(v.PhotoURL),
				VendorID:           vendorID,
				VendorNameOverride: pgText(v.VendorNameOverride),
				Jabatan:            pgText(v.Jabatan),
				Email:              pgTextBlankNull(v.Email),
				}); err != nil {
					return MapError(err)
				}
			}
			for _, purposeID := range purposes {
				if err := q.InsertVisitPurpose(ctx, db.InsertVisitPurposeParams{
					VisitRequestID: row.ID,
					PurposeID:      purposeID,
				}); err != nil {
					return MapError(err)
				}
			}
			if err := emit(ctx, q, domain.CreatedNotification(row.VisitID), row.ID, row.LocationID, row.VendorUserID, time.Now(), snap); err != nil {
				return err
			}
			created = row
			return nil
		})
		if err == nil {
			return visitRowToDomain(created)
		}
		lastErr = err
	}
	return domain.VisitRequest{}, lastErr
}

// FindByID resolves one visit by primary key, with its technician roster
// attached (openapi VisitorItem, including photo_url) in one extra indexed
// lookup. A single GET pays it; the paged list batches it instead.
func (r *visitRepository) FindByID(ctx context.Context, id domain.UUID) (domain.VisitRequest, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	row, err := db.New(r.pool).GetVisitByID(ctx, db.GetVisitByIDParams{ID: parsed})
	if err != nil {
		return domain.VisitRequest{}, MapError(err)
	}
	visit, err := detailRowToDomain(row)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	return r.withVisitors(ctx, visit)
}

// ListStatusHistory returns the actor-resolved status trail of one visit,
// oldest -> newest (the SQL window keeps only the 50 newest rows, so an
// ancient visit cannot grow an unbounded payload). The actor display data
// comes from the query's users/role LEFT JOINs: a NULL changed_by (the
// background auto-rule worker) yields nil actor pointers, an unknown or
// missing role maps through domain.RoleLabel to "" and is dropped so the
// wire renders null instead of an empty label, and a NULL/blank note maps to
// nil. An empty slice means "no history rows yet" and is not an error: a
// freshly created visit may have none.
func (r *visitRepository) ListStatusHistory(ctx context.Context, id domain.UUID) ([]domain.StatusEvent, error) {
	parsed, err := fromDomainUUID(id)
	if err != nil {
		return nil, err
	}
	rows, err := db.New(r.pool).ListStatusHistory(ctx, db.ListStatusHistoryParams{VisitRequestID: parsed})
	if err != nil {
		return nil, MapError(err)
	}
	events := make([]domain.StatusEvent, 0, len(rows))
	for _, row := range rows {
		event := domain.StatusEvent{
			Status: domain.VisitStatus(row.Status),
			At:     row.ChangedAt,
		}
		if name := strings.TrimSpace(row.ChangedByName.String); row.ChangedByName.Valid && name != "" {
			event.ActorName = &name
		}
		if role := domain.RoleLabel(strings.TrimSpace(row.ChangedByRole.String)); row.ChangedByRole.Valid && role != "" {
			event.ActorRoleLabel = &role
		}
		if note := strings.TrimSpace(row.Notes.String); row.Notes.Valid && note != "" {
			event.Notes = &note
		}
		events = append(events, event)
	}
	return events, nil
}

// FindByVisitCode resolves one visit by its printed VST-XXXXXXXXXX code: the
// Triple-Mode Scanner manual fallback. A bogus code becomes ErrNotFound.
func (r *visitRepository) FindByVisitCode(ctx context.Context, code string) (domain.VisitRequest, error) {
	row, err := db.New(r.pool).GetVisitByVisitCode(ctx, db.GetVisitByVisitCodeParams{VisitID: code})
	if err != nil {
		return domain.VisitRequest{}, MapError(err)
	}
	visit, err := visitCodeRowToDomain(row)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	return r.withVisitors(ctx, visit)
}

// withVisitors attaches the technician roster and the purpose catalogue to
// one already-mapped visit. Each travels in its own indexed lookup, so a
// single GET pays at most two extra queries, never an N+1. Either query
// failing is a storage error, not an empty slice: it is reported so a
// half-built detail never renders as a visit with no visitors or purposes.
func (r *visitRepository) withVisitors(ctx context.Context, visit domain.VisitRequest) (domain.VisitRequest, error) {
	parsed, err := fromDomainUUID(visit.ID)
	if err != nil {
		return domain.VisitRequest{}, err
	}
	q := db.New(r.pool)
	rows, err := q.ListVisitors(ctx, db.ListVisitorsParams{VisitRequestIds: []uuid.UUID{parsed}})
	if err != nil {
		return domain.VisitRequest{}, MapError(err)
	}
	visit.Visitors = make([]domain.Visitor, 0, len(rows))
	for _, row := range rows {
		visit.Visitors = append(visit.Visitors, visitorModelToDomain(row))
	}
	purposeRows, err := q.ListVisitPurposes(ctx, db.ListVisitPurposesParams{VisitRequestIds: []uuid.UUID{parsed}})
	if err != nil {
		return domain.VisitRequest{}, MapError(err)
	}
	visit.Purposes = make([]domain.Purpose, 0, len(purposeRows))
	for _, row := range purposeRows {
		visit.Purposes = append(visit.Purposes, purposeModelToDomain(row))
	}
	return visit, nil
}

// ListVisitorJabatan serves the roster combobox suggestion list: the distinct,
// alphabetically ordered Jabatan values already stored on visitor rows. The
// query drops NULL/blanks and caps the result at 50; the generated column stays
// pgtype.Text because the database type is nullable, so the valid rows are
// projected onto plain strings here. An empty result is a non-nil empty slice
// so the handler renders `"data": []`, never null.
func (r *visitRepository) ListVisitorJabatan(ctx context.Context) ([]string, error) {
	rows, err := db.New(r.pool).ListVisitorJabatan(ctx)
	if err != nil {
		return nil, MapError(err)
	}
	values := make([]string, 0, len(rows))
	for _, row := range rows {
		if !row.Valid {
			continue
		}
		values = append(values, row.String)
	}
	return values, nil
}

// genVisitCode mints a VST- + 10 digits code with crypto randomness.
func genVisitCode() (string, error) {
	const digits = "0123456789"
	code := make([]byte, 10)
	for i := range code {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(digits))))
		if err != nil {
			return "", fmt.Errorf("repository: mint visit code: %w: %v", domain.ErrDatabase, err)
		}
		code[i] = digits[n.Int64()]
	}
	return "VST-" + string(code), nil
}
