package visit

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/validation"
)

// suggestionResultLimit caps the merged vendor suggestion list. The member
// list is capped inside the SQL (20 rows) because its dedupe happens there.
const suggestionResultLimit = 50

// MemberSuggestionsInput carries the caller-supplied member reuse knobs.
// Vendor is the optional display-name narrow for admin/super_admin only; a
// vendor caller may send it, but it is IGNORED because ownership is that
// role's entire scope. There is deliberately no vendor_user_id member: an
// admin may never enumerate another account's members by id.
type MemberSuggestionsInput struct {
	Query  string
	Vendor string
}

// WithSuggestions wires the read-only suggestion port and returns the service
// for chaining at the composition root.
func (s *Service) WithSuggestions(repo domain.SuggestionRepository) *Service {
	s.suggestions = repo
	return s
}

// ListVendorSuggestions serves GET /vendors/suggestions: deduped company
// names for the visit form. super_admin/dev-superadmin see every source
// globally; an admin sees only names attached to a visit inside its branch
// union (the resolver stash, scalar primary as fallback, empty = fail-closed).
// security and vendor are refused with 403. The endpoint is read-only: a
// client typing a new company never writes master data.
func (s *Service) ListVendorSuggestions(ctx context.Context, actor Actor, query string) ([]domain.VendorSuggestion, error) {
	if err := actor.requireRole(domain.RoleSuperAdmin, domain.RoleAdmin); err != nil {
		return nil, err
	}
	q, err := normalizeSuggestionQuery(query)
	if err != nil {
		return nil, err
	}
	if s.suggestions == nil {
		return nil, domain.ErrDatabase
	}
	filter := domain.VendorSuggestionFilter{Query: q}
	if domain.IsSuperAdminRole(actor.Role) {
		filter.IsGlobal = true
	} else {
		filter.LocationIDs = branchUnion(actor)
		filter.IsGlobal = actor.IsGlobal
	}
	raw, err := s.suggestions.ListVendorSuggestions(ctx, filter)
	if err != nil {
		return nil, err
	}
	return mergeVendorSuggestions(raw), nil
}

// ListMemberSuggestions serves GET /visits/member-suggestions: the roster
// members worth reusing on a new visit. A vendor is pinned to its own
// vendor_user_id (any ?vendor= value is ignored); an admin is pinned to its
// branch union; super_admin is global. security is refused with 403. Whatever
// the role, the payload never carries a photo URL.
func (s *Service) ListMemberSuggestions(ctx context.Context, actor Actor, in MemberSuggestionsInput) ([]domain.MemberSuggestion, error) {
	if err := actor.requireRole(domain.RoleSuperAdmin, domain.RoleAdmin, domain.RoleVendor); err != nil {
		return nil, err
	}
	q, err := normalizeSuggestionQuery(in.Query)
	if err != nil {
		return nil, err
	}
	if s.suggestions == nil {
		return nil, domain.ErrDatabase
	}
	filter := domain.MemberSuggestionFilter{Query: q}
	switch {
	case actor.Role == domain.RoleVendor:
		vendorUserID := actor.ID
		filter.VendorUserID = &vendorUserID
	case domain.IsSuperAdminRole(actor.Role):
		filter.IsGlobal = true
		filter.VendorName = strings.TrimSpace(in.Vendor)
	default:
		filter.LocationIDs = branchUnion(actor)
		filter.IsGlobal = actor.IsGlobal
		filter.VendorName = strings.TrimSpace(in.Vendor)
	}
	items, err := s.suggestions.ListMemberSuggestions(ctx, filter)
	if err != nil {
		return nil, err
	}
	if items == nil {
		return []domain.MemberSuggestion{}, nil
	}
	return items, nil
}

// GetMemberSuggestion serves GET /visits/member-suggestions/{visitorId}: one
// picked member with presigned KTP/selfie links for autofill. The visitor's
// OWNING VISIT is authorized with the same predicate as the visit detail, and
// every refusal (unknown visitor, out-of-scope branch, another vendor's visit)
// becomes 404 so the endpoint never confirms that an out-of-scope id exists.
// VendorName is the member's own company resolved from the visitor row, not the
// visit-level "Vendor Pengaju".
func (s *Service) GetMemberSuggestion(ctx context.Context, actor Actor, visitorID domain.UUID) (domain.MemberSuggestionDetail, error) {
	if err := actor.requireRole(domain.RoleSuperAdmin, domain.RoleAdmin, domain.RoleVendor); err != nil {
		return domain.MemberSuggestionDetail{}, err
	}
	if s.suggestions == nil {
		return domain.MemberSuggestionDetail{}, domain.ErrDatabase
	}
	visitor, err := s.suggestions.FindVisitorByID(ctx, visitorID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) || errors.Is(err, domain.ErrValidation) {
			return domain.MemberSuggestionDetail{}, domain.NotFoundEntity("Anggota")
		}
		return domain.MemberSuggestionDetail{}, err
	}
	visit, err := s.visits.FindByID(ctx, visitor.VisitRequestID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) || errors.Is(err, domain.ErrValidation) {
			return domain.MemberSuggestionDetail{}, domain.NotFoundEntity("Anggota")
		}
		return domain.MemberSuggestionDetail{}, err
	}
	if err := authorizeVisitRead(actor, visit); err != nil {
		return domain.MemberSuggestionDetail{}, domain.NotFoundEntity("Anggota")
	}
	return domain.MemberSuggestionDetail{
		Name:     visitor.Name,
		IDNumber: visitor.IDNumber,
		Phone:    visitor.Phone,
		Email:    visitor.Email,
		Jabatan:  visitor.Jabatan,
		// VendorName is the member's OWN company resolved from the visitor row
		// (visitor override > catalogue), NOT the visit-level "Vendor Pengaju".
		VendorName:     optionalTrimmedText(visitor.VendorName),
		IDCardPhotoURL: s.presignStoredURL(ctx, visitor.IDCardPhotoURL),
		PhotoURL:       s.presignStoredURL(ctx, visitor.PhotoURL),
		SourceVisitID:  visitor.VisitRequestID,
	}, nil
}

// optionalTrimmedText trims an optional free-text value and maps the blank
// result to nil, so the wire never carries an empty string where null means
// "not set".
func optionalTrimmedText(raw string) *string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeSuggestionQuery trims the free-text filter and refuses one longer
// than the shared cap instead of silently truncating it: the handler answers a
// consistent 400/422 validation error before any query runs.
func normalizeSuggestionQuery(raw string) (string, error) {
	q := strings.TrimSpace(raw)
	if validation.RuneLen(q) > validation.SuggestionQueryMaxLength {
		return "", domain.ValidationFailure("Kata kunci pencarian maksimal " +
			strconv.Itoa(validation.SuggestionQueryMaxLength) + " karakter.")
	}
	return q, nil
}

// mergeVendorSuggestions applies the dedupe + priority rule on the raw SQL
// sources: case-insensitive and trimmed, keeping the HIGHEST priority source
// (master > account > history) and that source's display casing. A same-source
// tie keeps the lexicographically smaller display name so the result is
// deterministic. The list is sorted by display name and capped.
func mergeVendorSuggestions(raw []domain.VendorSuggestion) []domain.VendorSuggestion {
	type picked struct {
		item domain.VendorSuggestion
		rank int
	}
	byKey := make(map[string]picked, len(raw))
	for _, item := range raw {
		name := strings.TrimSpace(item.Name)
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		rank := vendorSuggestionRank(item.Source)
		current, exists := byKey[key]
		if !exists || rank < current.rank || (rank == current.rank && name < current.item.Name) {
			byKey[key] = picked{item: domain.VendorSuggestion{Name: name, Source: item.Source}, rank: rank}
		}
	}
	out := make([]domain.VendorSuggestion, 0, len(byKey))
	for _, p := range byKey {
		out = append(out, p.item)
	}
	sort.Slice(out, func(i, j int) bool {
		left, right := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if left != right {
			return left < right
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > suggestionResultLimit {
		out = out[:suggestionResultLimit]
	}
	return out
}

// vendorSuggestionRank maps a source onto its priority (lower wins). An
// unknown source ranks last rather than winning a name.
func vendorSuggestionRank(source domain.VendorSuggestionSource) int {
	switch source {
	case domain.VendorSuggestionSourceMaster:
		return 1
	case domain.VendorSuggestionSourceAccount:
		return 2
	case domain.VendorSuggestionSourceHistory:
		return 3
	default:
		return 4
	}
}
