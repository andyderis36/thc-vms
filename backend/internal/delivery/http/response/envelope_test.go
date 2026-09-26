package response_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
)

// record builds a throwaway gin context plus the recorder that captures the
// single exchange a helper under test performs.
func record(t *testing.T) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(rec)
	return ctx, rec
}

// decode reads the written body once, then asserts the envelope object holds
// exactly the mandated keys - no more, no fewer.
func decode(t *testing.T, rec *httptest.ResponseRecorder, wantKeys ...string) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not a JSON object: %v (%s)", err, rec.Body.String())
	}
	if got, want := len(body), len(wantKeys); got != want {
		t.Errorf("envelope has %d keys (%v), want exactly %d (%v)", got, keysOf(body), want, wantKeys)
	}
	for _, key := range wantKeys {
		if _, present := body[key]; !present {
			t.Errorf("envelope is missing the %q key; got %v", key, keysOf(body))
		}
	}
	return body
}

func keysOf(body map[string]any) []string {
	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	return keys
}

func TestOK_WritesSuccessEnvelopeWithData(t *testing.T) {
	// Given: the mandated success shape from docs/4. openapi.yaml L12.
	// When:  a handler serialises a payload with OK.
	// Then:  200 comes back with {"success":true,"data":...} and no "error" key.
	ctx, rec := record(t)

	type payload struct {
		VisitID string `json:"visit_id"`
	}
	response.OK(ctx, payload{VisitID: "VST-0000000001"})

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	body := decode(t, rec, "success", "data")
	if body["success"] != true {
		t.Errorf("success = %v, want true", body["success"])
	}
	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data = %v, want a JSON object", body["data"])
	}
	if data["visit_id"] != "VST-0000000001" {
		t.Errorf("data.visit_id = %v, want VST-0000000001", data["visit_id"])
	}
}

func TestOK_OmitsDataKeyWhenThereIsNothingToReport(t *testing.T) {
	// Given: an endpoint that succeeds without a payload.
	// When:  it calls OK with a nil value.
	// Then:  the envelope is {"success":true} alone - no empty data member.
	ctx, rec := record(t)

	var nothing map[string]string
	response.OK(ctx, nothing)

	body := decode(t, rec, "success")
	if body["success"] != true {
		t.Errorf("success = %v, want true", body["success"])
	}
}

func TestCreated_Writes201(t *testing.T) {
	// Given: a resource creation endpoint.
	// When:  it calls Created.
	// Then:  the status is 201 and the body is still the success envelope.
	ctx, rec := record(t)

	type createdUser struct {
		ID string `json:"id"`
	}
	response.Created(ctx, createdUser{ID: "0f1e2d3c"})

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201", rec.Code)
	}
	decode(t, rec, "success", "data")
}

func TestFail_ProjectsDomainSentinelOntoStatusAndCode(t *testing.T) {
	// Given: the domain errors whose user-facing text the PRD fixes.
	// When:  a handler passes them to Fail.
	// Then:  each becomes the matching HTTP status plus a machine code, and
	//        the response carries only success/error - never data.
	for _, tc := range []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
		wantMsg    string
	}{
		{
			name:       "invalid credentials",
			err:        domain.InvalidCredentials(),
			wantStatus: http.StatusUnauthorized,
			wantCode:   "INVALID_CREDENTIALS",
			wantMsg:    "Kredensial tidak valid",
		},
		{
			name:       "cross branch access",
			err:        domain.ForbiddenBranch(),
			wantStatus: http.StatusForbidden,
			wantCode:   "FORBIDDEN_BRANCH",
			wantMsg:    "Tidak berhak mengelola kunjungan cabang lain",
		},
		{
			name:       "outside the check-in tolerance window",
			err:        domain.CheckInWindowExceeded(),
			wantStatus: http.StatusBadRequest,
			wantCode:   "CHECKIN_WINDOW_EXCEEDED",
			wantMsg:    "Kunjungan belum dibuka atau sudah melewati batas waktu toleransi.",
		},
		{
			name:       "invalid status transition",
			err:        domain.NewInvalidTransition(domain.VisitStatusRescheduled, domain.VisitStatusVisiting),
			wantStatus: http.StatusConflict,
			wantCode:   "INVALID_TRANSITION",
			wantMsg:    "Transisi status kunjungan tidak diizinkan.",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, rec := record(t)

			response.Fail(ctx, tc.err)

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			body := decode(t, rec, "success", "error")
			if body["success"] != false {
				t.Errorf("success = %v, want false", body["success"])
			}
			errBody, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatalf("error = %v, want a JSON object", body["error"])
			}
			if len(errBody) != 2 {
				t.Errorf("error has %d keys (%v), want exactly code and message", len(errBody), keysOf(errBody))
			}
			if errBody["code"] != tc.wantCode {
				t.Errorf("error.code = %v, want %q", errBody["code"], tc.wantCode)
			}
			if errBody["message"] != tc.wantMsg {
				t.Errorf("error.message = %v, want %q", errBody["message"], tc.wantMsg)
			}
		})
	}
}

func TestFail_KeepsTheOriginalErrorUnwrappable(t *testing.T) {
	// Given: a domain sentinel joined with an outer-layer note.
	// When:  it reaches Fail.
	// Then:  the HTTP projection is unchanged and the root sentinel is still
	//        resolvable, so logging callers keep their diagnosis.
	ctx, rec := record(t)
	cause := errors.Join(domain.ForbiddenBranch(), errors.New("scoping visit 42"))

	response.Fail(ctx, cause)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
	if appErr := domain.FromError(cause); appErr.Code != "FORBIDDEN_BRANCH" {
		t.Errorf("FromError().Code = %q, want FORBIDDEN_BRANCH", appErr.Code)
	}
	if !errors.Is(cause, domain.ErrForbiddenBranch) {
		t.Error("errors.Is could not resolve the wrapped sentinel")
	}
}

func TestFail_MasksUnrecognisedErrorsAsInternal(t *testing.T) {
	// Given: an error the domain does not recognise.
	// When:  it reaches Fail.
	// Then:  nothing internal leaks - the client only sees a generic 500.
	ctx, rec := record(t)
	cause := errors.New(`pq: password authentication failed for user "thc_user"`)

	response.Fail(ctx, cause)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	body := decode(t, rec, "success", "error")
	errBody := body["error"].(map[string]any)
	if errBody["code"] != "INTERNAL_ERROR" {
		t.Errorf("error.code = %v, want INTERNAL_ERROR", errBody["code"])
	}
	if errBody["message"] == cause.Error() {
		t.Error("error.message leaked the internal cause to the client")
	}
}

func TestFailWith_WritesAnExplicitStatus(t *testing.T) {
	// Given: a handler that knows the status itself, e.g. a bind failure.
	// When:  it calls FailWith.
	// Then:  that status and that code/message reach the client verbatim.
	ctx, rec := record(t)

	response.FailWith(ctx, http.StatusRequestEntityTooLarge, "FILE_TOO_LARGE", "Berkas melebihi batas ukuran.")

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", rec.Code)
	}
	body := decode(t, rec, "success", "error")
	errBody := body["error"].(map[string]any)
	if errBody["code"] != "FILE_TOO_LARGE" || errBody["message"] != "Berkas melebihi batas ukuran." {
		t.Errorf("error = %v, want the supplied code and message", errBody)
	}
}
