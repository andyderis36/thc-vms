package domain

import (
	"fmt"
	"net/http"
	"testing"
)

// Given a FileTooLargeError wrapped by another layer, when FromError funnels
// it, then the envelope is the mandated 413 FILE_TOO_LARGE with the exact
// byte-limit message, so a deep wrap cannot downgrade the refusal to a 500.
func TestFromError_FileTooLargeWrapped(t *testing.T) {
	err := fmt.Errorf("wrap: %w", &FileTooLargeError{Limit: 5242880})

	appErr := FromError(err)
	if appErr == nil {
		t.Fatal("FromError must not return nil for a non-nil error")
	}
	if appErr.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", appErr.Status, http.StatusRequestEntityTooLarge)
	}
	if appErr.Code != "FILE_TOO_LARGE" {
		t.Fatalf("code = %q, want FILE_TOO_LARGE", appErr.Code)
	}
	const want = "Ukuran berkas melebihi batas 5242880 byte."
	if appErr.Message != want {
		t.Fatalf("message = %q, want %q", appErr.Message, want)
	}
}

// Given a bare FileTooLargeError, when FromError funnels it, then it becomes
// the same 413 envelope without needing a wrapper.
func TestFromError_FileTooLargeDirect(t *testing.T) {
	appErr := FromError(&FileTooLargeError{Limit: 1024})
	if appErr.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", appErr.Status, http.StatusRequestEntityTooLarge)
	}
	if appErr.Code != "FILE_TOO_LARGE" {
		t.Fatalf("code = %q, want FILE_TOO_LARGE", appErr.Code)
	}
}
