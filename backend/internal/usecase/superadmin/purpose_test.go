package superadmin_test

import (
	"strings"
	"testing"

	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/superadmin"
	"thc-vms/backend/internal/validation"
)

func TestValidatePurposeCreate(t *testing.T) {
	if err := superadmin.ValidatePurposeCreate("Splicing Fiber Optik"); err != nil {
		t.Fatalf("valid purpose name must be accepted: %v", err)
	}
	mustAppError(t, superadmin.ValidatePurposeCreate("  "), 400, "VALIDATION_ERROR")
	tooLong := strings.Repeat("a", validation.PurposeNameMaxLength+1)
	mustAppError(t, superadmin.ValidatePurposeCreate(tooLong), 400, "VALIDATION_ERROR")
}

func TestValidatePurposePatch(t *testing.T) {
	mustAppError(t, superadmin.ValidatePurposePatch(domain.PurposePatch{}), 400, "VALIDATION_ERROR")

	name := "Maintenance Genset"
	if err := superadmin.ValidatePurposePatch(domain.PurposePatch{Name: &name}); err != nil {
		t.Fatalf("single name patch must be accepted: %v", err)
	}
	active := false
	if err := superadmin.ValidatePurposePatch(domain.PurposePatch{IsActive: &active}); err != nil {
		t.Fatalf("is_active-only patch must be accepted: %v", err)
	}

	blank := "  "
	mustAppError(t, superadmin.ValidatePurposePatch(domain.PurposePatch{Name: &blank}), 400, "VALIDATION_ERROR")
	tooLong := strings.Repeat("a", validation.PurposeNameMaxLength+1)
	mustAppError(t, superadmin.ValidatePurposePatch(domain.PurposePatch{Name: &tooLong}), 400, "VALIDATION_ERROR")
}

func TestCheckPurposeReferences(t *testing.T) {
	if err := superadmin.CheckPurposeReferences(0); err != nil {
		t.Fatalf("zero references must be accepted: %v", err)
	}
	mustAppError(t, superadmin.CheckPurposeReferences(3), 409, "CONFLICT")
}
