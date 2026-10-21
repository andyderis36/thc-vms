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
			err := ValidatePhotoURL(tc.raw, nil)
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

// TestValidatePhotoURL_TrustedStorageOrigin pins the LAN-deployment case: a
// plain-http URL on the deployment's own object-storage host is accepted
// (that is the URL the storage adapter itself hands out), while the same
// scheme on any other host stays refused.
func TestValidatePhotoURL_TrustedStorageOrigin(t *testing.T) {
	t.Parallel()
	allow := NewFileOriginAllowlist(
		"http://10.11.6.110/s3/thc-vms-bucket",
		"minio:9000",
		"https://vms.thckalbar.com",
		"",
	)
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"trusted host from public base accepted", "http://10.11.6.110/s3/thc-vms-bucket/id_cards/pending-1/ktp.jpg", false},
		{"trusted host from bare endpoint accepted", "http://minio:9000/thc-vms-bucket/x.jpg", false},
		{"other plain-http host still refused", "http://example.com/x.jpg", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := ValidatePhotoURL(tc.raw, allow)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("ValidatePhotoURL(%q) = nil, want validation failure", tc.raw)
				}
				if !errors.Is(err, domain.ErrValidation) {
					t.Fatalf("ValidatePhotoURL(%q) = %v, want validation failure", tc.raw, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ValidatePhotoURL(%q) = %v, want nil", tc.raw, err)
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
	actor := testActor(domain.RoleVendor, "vendor-1", "")

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
