package visit

import (
	"context"
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestCreateVisit_RequiresAssignmentLetter pins the CREATE-only SPK rule:
// a new request without assignment_letter_url is a 400 ValidationFailure.
// Grandfathered rows (GET/list/update/reschedule) never pass through here.
func TestCreateVisit_RequiresAssignmentLetter(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "vendor-1", "")

	cases := map[string]func(in *CreateVisitInput){
		"nil SPK":        func(in *CreateVisitInput) { in.AssignmentLetterURL = nil },
		"empty SPK":      func(in *CreateVisitInput) { s := ""; in.AssignmentLetterURL = &s },
		"whitespace SPK": func(in *CreateVisitInput) { s := "   "; in.AssignmentLetterURL = &s },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			in := validCreateInput()
			mutate(&in)
			_, err := svc.CreateVisit(context.Background(), actor, in)
			if err == nil {
				t.Fatal("create without SPK must be rejected, got nil error")
			}
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("create without SPK error = %v, want validation failure", err)
			}
			if !strings.Contains(err.Error(), "Surat Tugas / SPK wajib diunggah.") {
				t.Fatalf("message = %q, want the FE-aligned SPK wording", err.Error())
			}
			if repo.createCalls != 0 {
				t.Fatalf("createCalls = %d, want 0 (rejected before repository)", repo.createCalls)
			}
		})
	}
}
