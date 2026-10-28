package storage

import (
	"errors"
	"testing"

	"github.com/minio/minio-go/v7"
)

func TestObjectMissing(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"no such key", minio.ErrorResponse{Code: "NoSuchKey", StatusCode: 404}, true},
		{"not found status", minio.ErrorResponse{Code: "NotFound", StatusCode: 404}, true},
		{"access denied", minio.ErrorResponse{Code: "AccessDenied", StatusCode: 403}, false},
		{"network failure", errors.New("dial tcp 127.0.0.1:9000: connect: connection refused"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := objectMissing(tc.err); got != tc.want {
				t.Fatalf("objectMissing(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
