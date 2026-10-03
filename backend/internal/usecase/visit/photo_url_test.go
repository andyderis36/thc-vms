package visit

import (
	"context"
	"errors"
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
)

// TestValidatePhotoURL pins the upload allowlist: empty means absent
// (allowed), https is accepted, http only for dev MinIO hosts, dangerous
// schemes and overlong values are rejected.
func TestValidatePhotoURL(t *testing.T) {
	t.Parallel()
	long := "https://cdn.example.com/" + strings.Repeat("a", 2048)
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"empty means absent", "", false},
		{"whitespace means absent", "   ", false},
		{"https MinIO accepted", "https://minio.example.com/thc-vms-bucket/id_card/visit-1/selfie.jpg", false},
		{"http localhost accepted", "http://localhost:9000/thc-vms-bucket/id_card/visit-1/selfie.jpg", false},
		{"http loopback accepted", "http://127.0.0.1:9000/b/x.jpg", false},
		{"javascript rejected", "javascript:alert(1)", true},
		{"javascript mixed case rejected", "JaVaScRiPt:alert(1)", true},
		{"data rejected", "data:text/html;base64,PGI+MQ==", true},
		{"blob rejected", "blob:https://cdn.example.com/uuid", true},
		{"vbscript rejected", "vbscript:msgbox(1)", true},
		{"http remote rejected", "http://example.com/x.jpg", true},
		{"overlong rejected", long, true},
		{"ftp rejected", "ftp://files.example.com/x.jpg", true},
		{"relative path rejected", "/id_card/visit-1/selfie.jpg", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := ValidatePhotoURL(tc.raw)
			if !tc.wantErr {
				if err != nil {
					t.Fatalf("ValidatePhotoURL(%q) = %v, want nil", tc.raw, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("ValidatePhotoURL(%q) = nil, want validation failure", tc.raw)
			}
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("ValidatePhotoURL(%q) = %v, want validation failure", tc.raw, err)
			}
		})
	}
}

// TestCreateVisit_RejectsMaliciousPhotoURL proves the wiring: a javascript:
// selfie and a javascript: assignment letter both fail format validation
// before any scope check or repository write.
func TestCreateVisit_RejectsMaliciousPhotoURL(t *testing.T) {
	repo := newFakeVisitRepo(t)
	svc := newTestService(repo, nil, testNow())
	actor := testActor(domain.RoleVendor, "pic-1", "")

	evil := "javascript:alert(1)"
	in := validCreateInput()
	in.Visitors[0].PhotoURL = &evil
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("javascript: selfie must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("selfie error = %v, want validation failure", err)
	}
	if repo.createCalls != 0 {
		t.Fatalf("createCalls = %d, want 0", repo.createCalls)
	}

	in = validCreateInput()
	in.AssignmentLetterURL = &evil
	if _, err := svc.CreateVisit(context.Background(), actor, in); err == nil {
		t.Fatal("javascript: assignment letter must be rejected, got nil error")
	} else if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("letter error = %v, want validation failure", err)
	}
	if repo.createCalls != 0 {
		t.Fatalf("createCalls = %d, want 0", repo.createCalls)
	}
}
