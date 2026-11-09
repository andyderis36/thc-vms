package visit

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/domain"
)

// errHistoryOutage is the canned storage failure standing in for a
// status_history table outage.
var errHistoryOutage = errors.New("history table unavailable")

// TestGetVisit_AttachesStatusHistoryAndNote proves the detail read serves the
// actor-resolved trail oldest -> newest, keeps a system row's actor pointers
// nil, resolves a human row's name + Indonesian role label, and derives the
// StatusNote from the NEWEST event's note.
func TestGetVisit_AttachesStatusHistoryAndNote(t *testing.T) {
	repo := newFakeVisitRepo(t)
	visit := seedRequestedVisit(repo)

	systemAt := time.Date(2026, time.September, 20, 8, 0, 0, 0, time.UTC)
	humanAt := time.Date(2026, time.September, 21, 9, 30, 0, 0, time.UTC)
	name := "Siti Rahayu"
	role := "Admin Cabang"
	note := "Geser jadwal, genset belum siap."
	repo.history = map[domain.UUID][]domain.StatusEvent{
		visit.ID: {
			{Status: domain.VisitStatusRequested, At: systemAt},
			{
				Status:         domain.VisitStatusRescheduled,
				At:             humanAt,
				ActorName:      &name,
				ActorRoleLabel: &role,
				Notes:          &note,
			},
		},
	}
	svc := newTestService(repo, gateMaster(), testNow())

	got, err := svc.GetVisit(context.Background(), testActor(domain.RoleAdmin, "admin-1", "loc-A"), "visit-1")
	if err != nil {
		t.Fatalf("GetVisit returned error: %v", err)
	}
	if len(got.History) != 2 {
		t.Fatalf("History length = %d, want 2", len(got.History))
	}
	if got.History[0].Status != domain.VisitStatusRequested || !got.History[0].At.Equal(systemAt) {
		t.Errorf("History[0] = %+v, want the oldest requested row", got.History[0])
	}
	if got.History[1].Status != domain.VisitStatusRescheduled || !got.History[1].At.Equal(humanAt) {
		t.Errorf("History[1] = %+v, want the newest rescheduled row", got.History[1])
	}
	if got.History[0].ActorName != nil || got.History[0].ActorRoleLabel != nil {
		t.Errorf("system row must carry nil actors, got %v / %v",
			got.History[0].ActorName, got.History[0].ActorRoleLabel)
	}
	if got.History[1].ActorName == nil || *got.History[1].ActorName != name {
		t.Errorf("human ActorName = %v, want %s", got.History[1].ActorName, name)
	}
	if got.History[1].ActorRoleLabel == nil || *got.History[1].ActorRoleLabel != role {
		t.Errorf("human ActorRoleLabel = %v, want %s", got.History[1].ActorRoleLabel, role)
	}
	if got.StatusNote == nil || *got.StatusNote != note {
		t.Errorf("StatusNote = %v, want the newest event's note %q", got.StatusNote, note)
	}
}

// TestGetVisit_HistoryTransientLogged proves a history-table outage stays
// diagnosable yet invisible to the client: the read succeeds with a nil
// trail and nil note while exactly one log entry carries the visit id and
// the error, mirroring the gate-outage contract.
func TestGetVisit_HistoryTransientLogged(t *testing.T) {
	repo := newFakeVisitRepo(t)
	seedRequestedVisit(repo)
	repo.historyErr = errHistoryOutage
	svc := newTestService(repo, gateMaster(), testNow())
	buf, restore := captureSlog(t)
	defer restore()

	got, err := svc.GetVisit(context.Background(), testActor(domain.RoleAdmin, "admin-1", "loc-A"), "visit-1")
	if err != nil {
		t.Fatalf("GetVisit returned error: %v", err)
	}
	if got.History != nil || got.StatusNote != nil {
		t.Errorf("transient failure must leave history/note nil, got %+v / %v", got.History, got.StatusNote)
	}
	out := buf.String()
	if strings.Count(out, "status history lookup failed") != 1 {
		t.Errorf("log must contain the failure exactly once, got:\n%s", out)
	}
	for _, want := range []string{"visit-1", errHistoryOutage.Error()} {
		if !strings.Contains(out, want) {
			t.Errorf("log must contain %q, got:\n%s", want, out)
		}
	}
}
