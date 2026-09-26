package jwt

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
)

// mapDirectory is a hand-written fake of Directory: no database, no network.
type mapDirectory struct {
	roles     map[domain.UUID]domain.RoleName
	locations map[domain.UUID]string
}

func (m mapDirectory) LookupRole(id domain.UUID) (domain.RoleName, error) {
	role, ok := m.roles[id]
	if !ok {
		return "", domain.ErrNotFound
	}
	return role, nil
}

func (m mapDirectory) LookupLocation(id domain.UUID) (string, error) {
	name, ok := m.locations[id]
	if !ok {
		return "", domain.ErrNotFound
	}
	return name, nil
}

func testConfig() *config.Config {
	return &config.Config{JWT: config.JWT{Secret: "thc-test-signing-secret-32-chars-min", ExpirationHours: 24}}
}

func testDirectory() mapDirectory {
	return mapDirectory{
		roles: map[domain.UUID]domain.RoleName{
			"role-superadmin": domain.RoleSuperAdmin,
			"role-admin":      domain.RoleAdmin,
			"role-security":   domain.RoleSecurity,
			"role-pic":        domain.RolePIC,
		},
		locations: map[domain.UUID]string{
			"loc-bandung": "THC Cabang Bandung",
		},
	}
}

func adminUser() domain.User {
	loc := domain.UUID("loc-bandung")
	return domain.User{
		ID:         "user-admin-1",
		Email:      "admin@thc.local",
		RoleID:     "role-admin",
		LocationID: &loc,
		Status:     domain.UserStatusActive,
		Type:       domain.UserTypeInternal,
	}
}

// decodePayload splits the token and decodes the RAW middle segment without
// verifying the signature, so tests assert on the exact wire JSON.
func decodePayload(t *testing.T, token string) (map[string]any, string) {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("expected 3 token segments, got %d", len(parts))
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	return payload, string(raw)
}

func TestJWT_RoundTripPreservesRoleAndLocation(t *testing.T) {
	svc := NewService(testConfig()).WithDirectory(testDirectory())

	token, err := svc.Issue(adminUser())
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	claims, err := svc.Parse(token)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if string(claims.Subject) != "user-admin-1" && claims.Subject != "user-admin-1" {
		t.Fatalf("sub = %q, want %q", claims.Subject, "user-admin-1")
	}
	if claims.Role != domain.RoleAdmin {
		t.Fatalf("role = %q, want %q", claims.Role, domain.RoleAdmin)
	}
	if claims.LocationID == nil || *claims.LocationID != "loc-bandung" {
		t.Fatalf("location_id = %v, want loc-bandung", claims.LocationID)
	}
	if claims.LocationName != "THC Cabang Bandung" {
		t.Fatalf("location_name = %q, want %q", claims.LocationName, "THC Cabang Bandung")
	}
}

func TestJWT_RejectsWrongAlgorithm(t *testing.T) {
	svc := NewService(testConfig())
	secret := []byte("thc-test-signing-secret-32-chars-min")

	// HS512 sibling signed with the same secret: must be refused.
	hs512 := jwt.NewWithClaims(jwt.SigningMethodHS512, jwt.MapClaims{"sub": "user-admin-1"})
	hs512Token, err := hs512.SignedString(secret)
	if err != nil {
		t.Fatalf("sign HS512: %v", err)
	}
	if _, err := svc.Parse(hs512Token); err == nil {
		t.Fatal("Parse accepted an HS512 token, want rejection")
	}

	// Unsigned alg:none token: must be refused.
	none := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{"sub": "user-admin-1"})
	noneToken, err := none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign alg:none: %v", err)
	}
	if _, err := svc.Parse(noneToken); err == nil {
		t.Fatal("Parse accepted an alg:none token, want rejection")
	}
}

func TestJWT_RejectsTamperedSignatureAndExpiredToken(t *testing.T) {
	svc := NewService(testConfig()).WithDirectory(testDirectory())
	secret := []byte("thc-test-signing-secret-32-chars-min")

	token, err := svc.Issue(adminUser())
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	parts := strings.Split(token, ".")
	// Flip the FIRST signature char: every one of its 6 base64 bits is
	// significant, unlike the tail char whose low bits decode to nothing.
	sig := parts[2]
	replacement := byte('a')
	if sig[0] == 'a' {
		replacement = 'b'
	}
	parts[2] = string(replacement) + sig[1:]
	if _, err := svc.Parse(strings.Join(parts, ".")); err == nil {
		t.Fatal("Parse accepted a tampered token, want rejection")
	}

	expired := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "user-admin-1",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-2 * time.Hour)),
		},
		Role:         domain.RoleAdmin,
		LocationName: "THC Cabang Bandung",
	})
	expiredToken, err := expired.SignedString(secret)
	if err != nil {
		t.Fatalf("sign expired: %v", err)
	}
	if _, err := svc.Parse(expiredToken); err == nil {
		t.Fatal("Parse accepted an expired token, want rejection")
	}
}

func TestJWT_LocationIDSerialisesAsNull(t *testing.T) {
	svc := NewService(testConfig()).WithDirectory(testDirectory())

	superAdmin := domain.User{
		ID:         "user-super-1",
		Email:      "superadmin@thc.local",
		RoleID:     "role-superadmin",
		LocationID: nil,
		Status:     domain.UserStatusActive,
		Type:       domain.UserTypeInternal,
	}
	token, err := svc.Issue(superAdmin)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	payload, raw := decodePayload(t, token)
	value, present := payload["location_id"]
	if !present {
		t.Fatal("location_id key missing from payload, want explicit null")
	}
	if value != nil {
		t.Fatalf("location_id = %v, want JSON null", value)
	}
	if !strings.Contains(raw, `"location_id":null`) {
		t.Fatalf("raw payload lacks literal null: %s", raw)
	}
}
