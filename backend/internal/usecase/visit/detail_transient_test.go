package visit

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// errTransientGate is the canned transient failure (e.g. connection reset)
// standing in for any non-ErrNotFound storage error.
var errTransientGate = errors.New("connection reset by peer")

// gateErrStore is a hand-written fake for domain.CheckInOutRepository where
// each lookup returns its canned error, so gate-table outages stay
// reproducible without a database.
type gateErrStore struct {
	checkInErr  error
	checkOutErr error
}

func (f *gateErrStore) RecordCheckIn(_ context.Context, _ domain.CheckIn) (domain.CheckIn, error) {
	return domain.CheckIn{}, nil
}

func (f *gateErrStore) RecordCheckOut(_ context.Context, _ domain.CheckOut) (domain.CheckOut, error) {
	return domain.CheckOut{}, nil
}

func (f *gateErrStore) FindCheckInByVisit(_ context.Context, _ domain.UUID) (domain.CheckIn, error) {
	if f.checkInErr != nil {
		return domain.CheckIn{}, f.checkInErr
	}
	return domain.CheckIn{}, domain.ErrNotFound
}

func (f *gateErrStore) FindCheckOutByVisit(_ context.Context, _ domain.UUID) (domain.CheckOut, error) {
	if f.checkOutErr != nil {
		return domain.CheckOut{}, f.checkOutErr
	}
	return domain.CheckOut{}, domain.ErrNotFound
}

// captureSlog swaps slog.Default for a text handler over a buffer so tests
// can assert on emitted entries. It returns the buffer plus a restore func.
func captureSlog(t *testing.T) (*bytes.Buffer, func()) {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	return &buf, func() { slog.SetDefault(prev) }
}

// TestWithGateTimes_TransientLogged proves a transient gate-table failure is
// diagnosable yet invisible to the client: GetVisit still succeeds with nil
// gate pointers while exactly one log entry carries visit id + op + err.
func TestWithGateTimes_TransientLogged(t *testing.T) {
	tests := []struct {
		name     string
		checkIn  error
		checkOut error
		wantOp   string
	}{
		{name: "checkin transient", checkIn: errTransientGate, wantOp: "FindCheckInByVisit"},
		{name: "checkout transient", checkOut: errTransientGate, wantOp: "FindCheckOutByVisit"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Given: a readable visit whose gate lookup fails transiently.
			repo := newFakeVisitRepo(t)
			seedRequestedVisit(repo)
			gates := &gateErrStore{checkInErr: tt.checkIn, checkOutErr: tt.checkOut}
			svc := NewService(repo, gateMaster(), fixedClock{now: testNow()}, gates, nil)
			buf, restore := captureSlog(t)
			defer restore()

			// When: the detail read runs.
			got, err := svc.GetVisit(context.Background(), testActor(domain.RoleAdmin, "admin-1", "loc-A"), "visit-1")

			// Then: the read succeeds with nil gate pointers and one log entry.
			if err != nil {
				t.Fatalf("GetVisit returned error: %v", err)
			}
			if got.CheckInAt != nil || got.CheckOutAt != nil || got.CheckedInBy != nil {
				t.Errorf("gate pointers must stay nil on transient failure, got in=%v out=%v by=%v",
					got.CheckInAt, got.CheckOutAt, got.CheckedInBy)
			}
			out := buf.String()
			if strings.Count(out, tt.wantOp) != 1 {
				t.Errorf("log must contain op %q exactly once, got:\n%s", tt.wantOp, out)
			}
			for _, want := range []string{"visit-1", errTransientGate.Error()} {
				if !strings.Contains(out, want) {
					t.Errorf("log must contain %q, got:\n%s", want, out)
				}
			}
		})
	}
}

// TestWithGateTimes_NotFoundSilent proves a missing gate row stays silent: no
// log entry, nil pointers, successful read.
func TestWithGateTimes_NotFoundSilent(t *testing.T) {
	tests := []struct {
		name     string
		checkIn  error
		checkOut error
	}{
		{name: "bare sentinel", checkIn: domain.ErrNotFound, checkOut: domain.ErrNotFound},
		{name: "wrapped entity", checkIn: domain.NotFoundEntity("Kunjungan"), checkOut: domain.NotFoundEntity("Kunjungan")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Given: a visit with no gate record yet.
			repo := newFakeVisitRepo(t)
			seedRequestedVisit(repo)
			gates := &gateErrStore{checkInErr: tt.checkIn, checkOutErr: tt.checkOut}
			svc := NewService(repo, gateMaster(), fixedClock{now: testNow()}, gates, nil)
			buf, restore := captureSlog(t)
			defer restore()

			// When: the detail read runs.
			got, err := svc.GetVisit(context.Background(), testActor(domain.RoleAdmin, "admin-1", "loc-A"), "visit-1")

			// Then: silent success with nil gate pointers.
			if err != nil {
				t.Fatalf("GetVisit returned error: %v", err)
			}
			if got.CheckInAt != nil || got.CheckOutAt != nil || got.CheckedInBy != nil {
				t.Errorf("gate pointers must be nil, got in=%v out=%v by=%v",
					got.CheckInAt, got.CheckOutAt, got.CheckedInBy)
			}
			if out := buf.String(); out != "" {
				t.Errorf("ErrNotFound must stay silent, got log:\n%s", out)
			}
		})
	}
}
