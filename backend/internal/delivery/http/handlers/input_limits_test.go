package handlers_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/domain"
)

func serveObject(t *testing.T, engine *gin.Engine, method, path string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return serve(engine, method, path, payload, "application/json")
}

func mustValidationError(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	mustStatus(t, rec, http.StatusBadRequest)
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "VALIDATION_ERROR" {
		t.Fatalf("want VALIDATION_ERROR envelope, got %q", rec.Body.String())
	}
}

func validCreateVisitBody() map[string]any {
	return map[string]any{
		"location_id":           "11111111-1111-1111-1111-111111111111",
		"purpose_ids":           []string{"22222222-2222-2222-2222-222222222222"},
		"start_date":            "2026-10-01T09:00:00Z",
		"end_date":              "2026-10-01T17:00:00Z",
		"is_nda_accepted":       true,
		"assignment_letter_url": "http://localhost:9000/thc-vms-bucket/assignment_letters/visit-1/spk.pdf",
		"visitors": []map[string]any{{
			"name": "Andi", "id_number": "3578010100000001", "phone": "081234567890",
		}},
	}
}

func TestCreateVisit_RejectsOutOfLimitFields(t *testing.T) {
	elevenVisitors := make([]map[string]any, 11)
	for i := range elevenVisitors {
		elevenVisitors[i] = map[string]any{
			"name": "Andi", "id_number": "3578010100000001", "phone": "081234567890",
		}
	}

	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"purpose note too long", func(b map[string]any) { b["purpose_note"] = strings.Repeat("a", 201) }},
		{"notes too long", func(b map[string]any) { b["notes"] = strings.Repeat("a", 1001) }},
		{"too many visitors", func(b map[string]any) { b["visitors"] = elevenVisitors }},
		{"visitor name too long", func(b map[string]any) { b["visitors"].([]map[string]any)[0]["name"] = strings.Repeat("a", 101) }},
		{"invalid id number", func(b map[string]any) { b["visitors"].([]map[string]any)[0]["id_number"] = "ID-123" }},
		{"invalid phone", func(b map[string]any) { b["visitors"].([]map[string]any)[0]["phone"] = "0811" }},
		{"vendor name too long", func(b map[string]any) { b["visitors"].([]map[string]any)[0]["vendor_name"] = strings.Repeat("a", 121) }},
		{"jabatan too long", func(b map[string]any) { b["visitors"].([]map[string]any)[0]["jabatan"] = strings.Repeat("a", 121) }},
		{"malformed member email", func(b map[string]any) { b["visitors"].([]map[string]any)[0]["email"] = "bukan-email" }},
		{"overlong member email", func(b map[string]any) {
			b["visitors"].([]map[string]any)[0]["email"] = strings.Repeat("a", 244) + "@example.co.id"
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := validCreateVisitBody()
			tc.mutate(body)
			engine := newVisitEngine(&fakeVisitService{}, domain.RoleVendor, "")
			mustValidationError(t, serveObject(t, engine, "POST", "/visits", body))
		})
	}
}

func TestVisitMutations_RejectOverlongText(t *testing.T) {
	long := strings.Repeat("a", 1001)
	cases := []struct {
		name string
		path string
		body map[string]any
	}{
		{"approve note", "/visits/visit-1/approve", map[string]any{"notes": long}},
		{"reject reason", "/visits/visit-1/reject", map[string]any{"reason": long}},
		{"cancel reason", "/visits/visit-1/cancel", map[string]any{"reason": long}},
		{"reschedule reason", "/visits/visit-1/reschedule", map[string]any{
			"start_date": "2026-10-02T09:00:00Z",
			"end_date":   "2026-10-02T17:00:00Z",
			"reason":     long,
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			engine := newVisitEngine(&fakeVisitService{}, domain.RoleAdmin, "loc-A")
			mustValidationError(t, serveObject(t, engine, "POST", tc.path, tc.body))
		})
	}
}

func TestCheckIn_RejectsOutOfLimitFields(t *testing.T) {
	cases := map[string]map[string]any{
		"badge code too long": {"badge_code": strings.Repeat("a", 65)},
		"notes too long":      {"notes": strings.Repeat("a", 501)},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			engine := newGateEngine(&fakeGateService{})
			mustValidationError(t, serveObject(t, engine, "POST", "/visits/VST-0000000001/checkin", body))
		})
	}
}

func TestCreateSecurity_RejectsInvalidAccountFields(t *testing.T) {
	cases := map[string]map[string]any{
		"name too long":  {"name": strings.Repeat("a", 101), "email": "baru@thc.local", "password": "Secret123!"},
		"invalid email":  {"name": "Pengawas", "email": "bukan-email", "password": "Secret123!"},
		"invalid phone":  {"name": "Pengawas", "email": "baru@thc.local", "phone": "0811", "password": "Secret123!"},
		"short password": {"name": "Pengawas", "email": "baru@thc.local", "password": "short"},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			engine := newUserEngine(newStubUserStore(), &stubMasterStore{}, domain.RoleAdmin, "loc-own")
			mustValidationError(t, serveObject(t, engine, "POST", "/users/security", body))
		})
	}
}

func TestUpdateSecurity_RejectsInvalidAccountFields(t *testing.T) {
	cases := map[string]map[string]any{
		"name too long":  {"name": strings.Repeat("a", 101)},
		"invalid phone":  {"phone": "0811"},
		"short password": {"password": "short"},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			store := newStubSecurityDeleteStore(securityUser("sec-1", "s1@thc.local", "loc-own"))
			engine := newSecurityDeleteEngine(store, domain.RoleAdmin, "loc-own")
			mustValidationError(t, serve(engine, "PATCH", "/users/security/sec-1", marshalJSONBody(t, body), "application/json"))
		})
	}
}

func TestSuperAdmin_RejectsOutOfLimitLocationFields(t *testing.T) {
	cases := map[string]map[string]any{
		"name too long":    {"name": strings.Repeat("a", 101), "type": "cabang"},
		"address too long": {"name": "Cabang", "type": "cabang", "address": strings.Repeat("a", 256)},
		"city too long":    {"name": "Cabang", "type": "cabang", "city": strings.Repeat("a", 256)},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			engine := newSuperAdminEngine(newStubManagedUsers(), newStubLocationAdmin(), domain.RoleSuperAdmin)
			mustValidationError(t, serveObject(t, engine, "POST", "/locations", body))
		})
	}
}

func TestSuperAdmin_RejectsInvalidManagedUserFields(t *testing.T) {
	cases := map[string]map[string]any{
		"name too long":  {"name": strings.Repeat("a", 101), "email": "v@thc.local", "password": "Secret123!", "role": "vendor"},
		"invalid email":  {"name": "Vendor", "email": "bukan-email", "password": "Secret123!", "role": "vendor"},
		"invalid phone":  {"name": "Vendor", "email": "v@thc.local", "phone": "0811", "password": "Secret123!", "role": "vendor"},
		"short password": {"name": "Vendor", "email": "v@thc.local", "password": "short", "role": "vendor"},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			engine := newSuperAdminEngine(newStubManagedUsers(), newStubLocationAdmin(), domain.RoleSuperAdmin)
			mustValidationError(t, serveObject(t, engine, "POST", "/users", body))
		})
	}
}

func TestSuperAdmin_UpdateManagedUserRejectsInvalidFields(t *testing.T) {
	cases := map[string]map[string]any{
		"name too long":  {"name": strings.Repeat("a", 101)},
		"invalid email":  {"email": "bukan-email"},
		"invalid phone":  {"phone": "0811"},
		"short password": {"password": "short"},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			users := newStubManagedUsers(managedAccount("target-1", "target@thc.local", domain.RoleAdmin, nil))
			engine := newSuperAdminEngine(users, newStubLocationAdmin(), domain.RoleSuperAdmin)
			mustValidationError(t, serveObject(t, engine, "PATCH", "/users/target-1", body))
		})
	}
}

func marshalJSONBody(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return b
}
