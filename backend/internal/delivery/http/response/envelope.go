// Package response serialises the single HTTP contract from docs/4.
// openapi.yaml L12: success is {"success":true,"data":...} and failure is
// {"success":false,"error":{"code":"...","message":"..."}}. Every handler in
// later waves answers through OK, Created, Fail or FailWith so no endpoint
// can invent its own shape.
package response

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/domain"
)

// Envelope is the wire shape. Data holds a pre-encoded payload and is
// omitted when empty, so a bare success is exactly {"success":true}; Error is
// set only on failure, so success and failure members never mix.
type Envelope struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data,omitempty"`
	Error   *ErrorBody      `json:"error,omitempty"`
}

// ErrorBody is the failure detail: a machine code for clients and logs plus
// the Bahasa Indonesia message shown to the user.
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// OK answers 200 with the success envelope around data. A nil payload omits
// the data member entirely instead of sending an empty object.
func OK[T any](c *gin.Context, data T) {
	writeSuccess(c, http.StatusOK, data)
}

// Created answers 201 with the success envelope around the created resource.
func Created[T any](c *gin.Context, data T) {
	writeSuccess(c, http.StatusCreated, data)
}

// Fail answers with the status, code and message that domain.FromError
// assigns to err. Unknown errors become a generic 500 without leaking the
// cause; the cause stays in err for the caller to log.
func Fail(c *gin.Context, err error) {
	appErr := domain.FromError(err)
	writeFailure(c, appErr.Status, appErr.Code, appErr.Message)
}

// FailWith answers with an explicit status, code and message for failures
// the handler classifies itself, such as a body that will not bind.
func FailWith(c *gin.Context, status int, code, message string) {
	writeFailure(c, status, code, message)
}

// writeSuccess encodes the payload once and wraps it in the success
// envelope. A payload that encodes to null (nil value, nil map) drops the
// data member; an encoding error can only mean a broken handler value, so it
// falls back to a static 500 that cannot fail the same way.
func writeSuccess[T any](c *gin.Context, status int, data T) {
	raw, err := json.Marshal(data)
	if err != nil {
		writeFailure(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Terjadi kesalahan pada server.")
		return
	}
	envelope := Envelope{Success: true}
	if string(raw) != "null" {
		envelope.Data = raw
	}
	c.JSON(status, envelope)
}

// writeFailure writes the failure envelope verbatim.
func writeFailure(c *gin.Context, status int, code, message string) {
	c.JSON(status, Envelope{
		Success: false,
		Error:   &ErrorBody{Code: code, Message: message},
	})
}
