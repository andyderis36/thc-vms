package auth

import (
	"context"
	"log/slog"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
	"thc-vms/backend/internal/validation"
)

// RegisterVendorInput is the validated shape behind POST /auth/register: the
// public self-registration body plus the caller's parsed vendor link. The
// role is fixed to vendor server-side and never read from the body.
type RegisterVendorInput struct {
	Name       string
	Email      string
	Password   string
	Phone      string
	NIK        string
	VendorID   *domain.UUID
	VendorName string
}

// RegisterVendor creates one vendor account with status pending: the account
// exists but cannot sign in until a superadmin flips it to active. Validation
// is exactly the managed-user create rule with role=vendor (name/email/
// password mandatory, NIK 16 digits, vendor catalogue-wins, no location), so
// the public path can never create a stronger account than the back office.
// A duplicate email surfaces the same 23505 -> 409 mapping the managed create
// relies on. The audit row is best-effort with a nil actor (public request,
// no session) and secret-free metadata; a trail failure is logged and never
// fails the registration itself.
func (s *Service) RegisterVendor(ctx context.Context, in RegisterVendorInput) (Profile, error) {
	if s.managed == nil || s.vendorRoleID == "" {
		return Profile{}, domain.FromError(errUnwired)
	}
	vendorName := strings.TrimSpace(in.VendorName)
	accountType, err := superadmin.ValidateManagedUserCreate(superadmin.ManagedUserInput{
		Name:       in.Name,
		Email:      in.Email,
		Password:   in.Password,
		Phone:      validation.NormalizePhone(in.Phone),
		NIK:        strings.TrimSpace(in.NIK),
		Role:       domain.RoleVendor,
		LocationID: nil,
		VendorID:   in.VendorID,
		VendorName: vendorName,
	})
	if err != nil {
		return Profile{}, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		return Profile{}, domain.FromError(err)
	}
	var vendorOverride *string
	if in.VendorID == nil && vendorName != "" {
		vendorOverride = &vendorName
	}
	created, err := s.managed.CreateManagedUser(ctx, domain.User{
		Name:               strings.TrimSpace(in.Name),
		Email:              strings.TrimSpace(in.Email),
		Phone:              validation.NormalizePhone(in.Phone),
		NIK:                strings.TrimSpace(in.NIK),
		PasswordHash:       string(hash),
		RoleID:             s.vendorRoleID,
		LocationID:         nil,
		Type:               accountType,
		Status:             domain.UserStatusPending,
		VendorID:           in.VendorID,
		VendorNameOverride: vendorOverride,
	})
	if err != nil {
		return Profile{}, err
	}
	s.recordRegister(ctx, created.ID, strings.TrimSpace(in.Email))
	return s.profile(ctx, created)
}

// recordRegister appends one user.create row for a public registration:
// actor is nil (no session exists yet) and the metadata names only the email,
// the fixed role and the public source. Secret values never enter.
func (s *Service) recordRegister(ctx context.Context, userID domain.UUID, email string) {
	if s.audit == nil {
		return
	}
	ip, userAgent := loginMeta(ctx)
	if _, err := s.audit.Append(ctx, domain.AuditEntry{
		Action:    domain.AuditActionUserCreate,
		Entity:    domain.AuditEntityUser,
		EntityID:  &userID,
		IP:        ip,
		UserAgent: userAgent,
		Metadata: map[string]string{
			"email":  email,
			"role":   string(domain.RoleVendor),
			"source": "self-registration",
		},
	}); err != nil {
		slog.Warn("auth: audit vendor registration failed", "user_id", string(userID), "error", err)
	}
}
