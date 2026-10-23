package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/response"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/visit"
)

// VisitService is the visit-lifecycle port this handler drives. *visit.Service
// satisfies it implicitly, so production wires the real service and tests wire
// a hand-written fake; no mocking library is involved.
type VisitService interface {
	ListVisits(ctx context.Context, actor visit.Actor, in visit.ListVisitsInput) ([]domain.VisitRequest, int64, error)
	CreateVisit(ctx context.Context, actor visit.Actor, in visit.CreateVisitInput) (domain.VisitRequest, error)
	GetVisit(ctx context.Context, actor visit.Actor, key string) (domain.VisitRequest, error)
	Approve(ctx context.Context, actor visit.Actor, visitID domain.UUID, note string) error
	Reject(ctx context.Context, actor visit.Actor, visitID domain.UUID, reason string) error
	Cancel(ctx context.Context, actor visit.Actor, visitID domain.UUID, note string) error
	Reschedule(ctx context.Context, actor visit.Actor, visitID domain.UUID, start, end time.Time, reason string) error
	ListJabatan(ctx context.Context) ([]string, error)
}

// Compile-time proof that the production service wires into the handler.
var _ VisitService = (*visit.Service)(nil)

// VisitHandler serves the eight visit-lifecycle operations. It only maps HTTP
// onto the usecase: branch/vendor scoping, the state machine and the schedule
// rules all live in the usecase, never here.
type VisitHandler struct {
	visits VisitService
}

// NewVisitHandler wires the handler to its usecase port.
func NewVisitHandler(svc VisitService) *VisitHandler {
	return &VisitHandler{visits: svc}
}

// List serves GET /visits. The actor travels through so the usecase applies
// branch/vendor scoping; location_id and search are accepted query params but
// never widen that scope. Answers the {items, total, page, limit} envelope.
func (h *VisitHandler) List(c *gin.Context) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	var status *domain.VisitStatus
	if raw := strings.TrimSpace(c.Query("status")); raw != "" {
		parsed, err := domain.ParseVisitStatus(raw)
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Status kunjungan tidak dikenal.")
			return
		}
		status = &parsed
	}
	page := queryInt(c.Query("page"), 1)
	limit := queryInt(c.Query("limit"), 10)
	// q is the documented free-text filter (openapi GET /visits): ILIKE over
	// vendor user name / visit_id in SQL. `search` stays accepted as a legacy alias so
	// older clients keep filtering; both are trimmed and an empty value means
	// unfiltered, never an error. It narrows within the actor's scope only.
	search := strings.TrimSpace(c.Query("q"))
	if search == "" {
		search = strings.TrimSpace(c.Query("search"))
	}
	// date_from/date_to is the documented window filter (openapi GET /visits):
	// vr.start_date >= date_from AND vr.start_date < date_to in SQL. Both
	// accept full RFC3339 (offset preserved, TZ-safe) or date-only YYYY-MM-DD
	// (midnight UTC); a date-only upper bound shifts +24h so the day stays
	// inclusive under the half-open SQL window. Empty means unfiltered.
	// A bad value or a reversed window is a 400, never a silent listing.
	// The pair only NARROWS within the actor's scope (usecase list.go assigns
	// LocationID/VendorUserID unconditionally): it can never widen visibility,
	// including for security whose scope stays the branch equality.
	from, err := parseVisitDateBound(strings.TrimSpace(c.Query("date_from")), false)
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format date_from tidak valid.")
		return
	}
	to, err := parseVisitDateBound(strings.TrimSpace(c.Query("date_to")), true)
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format date_to tidak valid.")
		return
	}
	if from != nil && to != nil && from.After(*to) {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Rentang tanggal tidak valid: date_from harus sebelum date_to.")
		return
	}
	// sort_by/order is the documented ordering pair (openapi GET /visits):
	// ?sort_by=created_at|start_date|end_date & ?order=asc|desc, defaulting to
	// created_at desc (legacy listing order). Either side may be omitted
	// independently; a value outside the vocabulary is a 400, never a silent
	// listing, so an unknown column can never travel toward SQL.
	rawQuery := c.Request.URL.RawQuery
	if sortValueDropped(rawQuery, "sort_by", c.Query("sort_by")) ||
		sortValueDropped(rawQuery, "order", c.Query("order")) {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Parameter sort_by atau order tidak valid.")
		return
	}
	sortBy, order, ok := parseVisitSort(c.Query("sort_by"), c.Query("order"))
	if !ok {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Parameter sort_by atau order tidak valid.")
		return
	}
	in := visit.ListVisitsInput{Status: status, Search: search, From: from, To: to, Page: page, Limit: limit, SortBy: sortBy, Order: order}

	// location_id is the documented optional branch filter (openapi L264-267,
	// PRD L109: superadmin may filter by branch). It is passed through as a
	// NARROWING hint only: the usecase assigns the actor's own scope
	// unconditionally for admin/security/vendor, so supplying another branch id
	// here can never widen a caller's visibility. An unparsable value is a
	// client error rather than a silently dropped filter.
	if raw := strings.TrimSpace(c.Query("location_id")); raw != "" {
		parsed, err := domain.ParseUUID(raw)
		if err != nil {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "location_id tidak valid.")
			return
		}
		in.LocationID = &parsed
	}

	items, total, err := h.visits.ListVisits(c.Request.Context(), actor, in)
	if err != nil {
		response.Fail(c, err)
		return
	}
	details := make([]visitDetailDTO, 0, len(items))
	for _, item := range items {
		details = append(details, toVisitDetail(item))
	}
	response.OK(c, visitListDTO{Items: details, Total: total, Page: page, Limit: limit})
}

// ListJabatan serves GET /jabatan: the distinct Jabatan values already entered
// on visitor rows, alphabetically sorted, as combobox suggestions. The list is
// not scoped by role or branch — it carries only free-text position labels —
// and an empty result answers `"data": []`, never null.
func (h *VisitHandler) ListJabatan(c *gin.Context) {
	values, err := h.visits.ListJabatan(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if values == nil {
		values = []string{}
	}
	response.OK(c, values)
}

// Create serves POST /visits. Binds CreateVisitRequest field for field and
// answers 201 with the created VisitDetail.
func (h *VisitHandler) Create(c *gin.Context) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	var body createVisitBody
	if err := c.ShouldBindJSON(&body); err != nil {
		// assignment_letter_url is the ONLY member carrying a binding tag,
		// so a non-syntax bind failure is always the missing SPK: answer
		// the FE-aligned wording, not the generic body message.
		var syntaxErr *json.SyntaxError
		var typeErr *json.UnmarshalTypeError
		if !errors.As(err, &syntaxErr) && !errors.As(err, &typeErr) {
			response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Surat Tugas / SPK wajib diunggah.")
			return
		}
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Isi permohonan kunjungan tidak valid.")
		return
	}
	if msg := checkCreateBody(body); msg != "" {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", msg)
		return
	}
	start, err := time.Parse(time.RFC3339, body.StartDate)
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Tanggal mulai kunjungan tidak valid.")
		return
	}
	end, err := time.Parse(time.RFC3339, body.EndDate)
	if err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Tanggal selesai kunjungan tidak valid.")
		return
	}
	in := toCreateInput(body, start, end)
	created, err := h.visits.CreateVisit(c.Request.Context(), actor, in)
	if err != nil {
		response.Fail(c, err)
		return
	}
	// The create path returns the bare row, so re-read through the GET path
	// before answering 201: the same usecase/repository enrichment fills
	// location/vendor user names, vendor_name, named purposes, roster and SPK URL.
	// A failed re-read never fails the create; the bare row still answers.
	if enriched, gerr := h.visits.GetVisit(c.Request.Context(), actor, string(created.ID)); gerr == nil {
		created = enriched
	}
	response.Created(c, toVisitDetail(created))
}

// Get serves GET /visits/{id}. The key is a uuid OR a VST- business code for
// the manual-scan path; the usecase resolves both.
func (h *VisitHandler) Get(c *gin.Context) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	key := strings.TrimSpace(c.Param("id"))
	if key == "" {
		response.Fail(c, domain.NotFoundEntity("Kunjungan"))
		return
	}
	found, err := h.visits.GetVisit(c.Request.Context(), actor, key)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toVisitDetail(found))
}

// Cancel serves POST /visits/{id}/cancel. The reason is optional per schema.
func (h *VisitHandler) Cancel(c *gin.Context) {
	actor, id, ok := h.mutationTarget(c)
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if !bindJSON(c, &body) {
		return
	}
	if err := h.visits.Cancel(c.Request.Context(), actor, id, body.Reason); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK[any](c, nil)
}

// QR serves GET /visits/{id}/qr with exactly {visit_id, qr_code_payload}.
// MVP decision: qr_code_payload == visit_id, because scanning the code and
// typing it manually (PRD manual path) are equivalent; the openapi response
// specifies no payload format, so the business code itself is the payload.
func (h *VisitHandler) QR(c *gin.Context) {
	actor, err := visitActor(c)
	if err != nil {
		response.Fail(c, err)
		return
	}
	key := strings.TrimSpace(c.Param("id"))
	if key == "" {
		response.Fail(c, domain.NotFoundEntity("Kunjungan"))
		return
	}
	found, err := h.visits.GetVisit(c.Request.Context(), actor, key)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, qrDTO{VisitID: found.VisitID, QRCodePayload: found.VisitID})
}

// bindJSON binds an optional JSON body. An empty body leaves dst untouched;
// malformed JSON is a 400. It reports whether the caller may continue.
func bindJSON(c *gin.Context, dst any) bool {
	if c.Request.ContentLength == 0 {
		return true
	}
	if err := c.ShouldBindJSON(dst); err != nil {
		response.FailWith(c, http.StatusBadRequest, "VALIDATION_ERROR", "Format isi permintaan tidak valid.")
		return false
	}
	return true
}

// checkCreateBody enforces the CreateVisitRequest presence rules that belong
// to HTTP mapping; deeper semantics (window order, NDA acceptance) stay in
// the usecase. Empty means valid.
func checkCreateBody(body createVisitBody) string {
	if strings.TrimSpace(body.LocationID) == "" {
		return "Lokasi kunjungan wajib diisi."
	}
	// Either a catalogue purpose or the free-typed "tujuan lain" satisfies
	// the visit reason; the usecase repeats the rule for callers that bypass
	// HTTP mapping.
	if len(body.PurposeIDs) < 1 && strings.TrimSpace(body.PurposeNote) == "" {
		return "Minimal satu tujuan kunjungan wajib dipilih atau ditulis."
	}
	if len([]rune(strings.TrimSpace(body.PurposeNote))) > 200 {
		return "Tujuan lain kunjungan maksimal 200 karakter."
	}
	if len(body.Visitors) < 1 {
		return "Minimal satu pengunjung wajib didaftarkan."
	}
	if len(body.Visitors) > 10 {
		return "Jumlah pengunjung maksimal 10 orang."
	}
	for i, visitor := range body.Visitors {
		n := i + 1
		if strings.TrimSpace(visitor.Name) == "" {
			return "Nama pengunjung ke-" + strconv.Itoa(n) + " wajib diisi."
		}
		if strings.TrimSpace(visitor.IDNumber) == "" {
			return "Nomor identitas pengunjung ke-" + strconv.Itoa(n) + " wajib diisi."
		}
		if strings.TrimSpace(visitor.Phone) == "" {
			return "Nomor telepon pengunjung ke-" + strconv.Itoa(n) + " wajib diisi."
		}
		if visitor.VendorID != nil {
			if id := strings.TrimSpace(*visitor.VendorID); id != "" {
				if _, err := domain.ParseUUID(id); err != nil {
					return "vendor_id pengunjung ke-" + strconv.Itoa(n) + " tidak valid."
				}
			}
		}
		if visitor.VendorName != nil {
			if len([]rune(strings.TrimSpace(*visitor.VendorName))) > 120 {
				return "Nama perusahaan vendor pengunjung ke-" + strconv.Itoa(n) + " maksimal 120 karakter."
			}
		}
	}
	if body.IsNDAAccepted == nil {
		return "Persetujuan NDA wajib diisi."
	}
	// SPK is mandatory for NEW requests only; grandfathered rows without one
	// keep flowing through GET/list/update/reschedule/approve untouched.
	if body.AssignmentLetterURL == nil || strings.TrimSpace(*body.AssignmentLetterURL) == "" {
		return "Surat Tugas / SPK wajib diunggah."
	}
	return ""
}

// parseVisitDateBound parses one ?date_from= / ?date_to= value for List.
// Empty means unfiltered (nil, no error). A value containing "T" parses as
// full RFC3339 with its offset preserved; anything else parses as date-only
// YYYY-MM-DD at midnight UTC. A date-only upper bound shifts +24h so the
// calendar day stays inclusive under the half-open SQL window
// (start_date >= from AND start_date < to).
func parseVisitDateBound(raw string, isUpper bool) (*time.Time, error) {
	if raw == "" {
		return nil, nil
	}
	if strings.Contains(raw, "T") {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return nil, err
		}
		return &parsed, nil
	}
	day, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return nil, err
	}
	if isUpper {
		day = day.Add(24 * time.Hour)
	}
	return &day, nil
}

// sortValueDropped reports whether RawQuery carries key= with a non-empty value
// that url.ParseQuery silently discarded (a raw ';' makes the stdlib skip the
// whole pair), while the parsed value is empty. Without this guard an injection
// probe like ?sort_by=created_at;DROP would degrade to the default listing
// instead of the 400 the contract requires. Only the sort pair is inspected:
// ?q=/date_* keep their legacy empty-means-unfiltered behaviour.
func sortValueDropped(rawQuery, key, parsed string) bool {
	if strings.TrimSpace(parsed) != "" {
		return false
	}
	for _, pair := range strings.Split(rawQuery, "&") {
		k, v, _ := strings.Cut(pair, "=")
		if k == key && v != "" {
			return true
		}
	}
	return false
}

// parseVisitSort maps the ?sort_by= / ?order= pair onto the domain sort
// vocabulary. Empty means the legacy default (created_at desc); ok=false
// means either side is outside the vocabulary and the caller must answer 400.
func parseVisitSort(rawSort, rawOrder string) (domain.VisitSortBy, domain.VisitSortOrder, bool) {
	sortBy := domain.VisitSortBy(strings.ToLower(strings.TrimSpace(rawSort)))
	order := domain.VisitSortOrder(strings.ToLower(strings.TrimSpace(rawOrder)))
	if sortBy == "" {
		sortBy = domain.VisitSortCreatedAt
	}
	if order == "" {
		order = domain.VisitSortDesc
	}
	switch sortBy {
	case domain.VisitSortCreatedAt, domain.VisitSortStartDate, domain.VisitSortEndDate:
	default:
		return "", "", false
	}
	switch order {
	case domain.VisitSortAsc, domain.VisitSortDesc:
	default:
		return "", "", false
	}
	return sortBy, order, true
}

// queryInt reads a positive query integer with a default fallback.
func queryInt(raw string, def int) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 {
		return def
	}
	return n
}
