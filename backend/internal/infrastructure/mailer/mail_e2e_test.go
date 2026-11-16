// End-to-end mail proof: the nine allowlisted lifecycle notices travel
// through the REAL SMTP adapter into Mailpit (dev-only SMTP catch-all
// on localhost:1025, no auth, no TLS) and are asserted through the Mailpit
// HTTP API on :8025. visit_requested rides the staff leg only (approvers),
// the other eight fan out per their audiences; the excluded list is
// intentionally empty (no lifecycle type is excluded from email).
//
// Recipient guard: every address is @example.com (Mailpit-only). Seeded
// users live at real domains and are NEVER used here — a test sending to a
// real domain is a defect. The inbox is wiped before and after the run, so
// no test data survives.
//
// Skip contract: testing.Short skips unconditionally; otherwise the test
// dials MAILPIT_SMTP_ADDR (default localhost:1025) and probes the Mailpit
// API (MAILPIT_API_BASE, default http://localhost:8025) and skips cleanly
// when Mailpit is not up. CI legs without Mailpit use SMTP_DRY_RUN=true
// instead (see smtp_dryrun_test.go), never this test.
package mailer_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/infrastructure/mailer"
)

const (
	e2eVisitCode = "E2E-MAIL-0001"
	e2eFrom      = "noreply@example.com"
)

func e2eSMTPAddr() string {
	if v := os.Getenv("MAILPIT_SMTP_ADDR"); v != "" {
		return v
	}
	return "localhost:1025"
}

func e2eAPIBase() string {
	if v := os.Getenv("MAILPIT_API_BASE"); v != "" {
		return strings.TrimSuffix(v, "/")
	}
	return "http://localhost:8025"
}

// mailpitAddr is one To/From entry in the Mailpit API JSON.
type mailpitAddr struct {
	Address string `json:"Address"`
}

// mailpitSummary is one entry of GET /api/v1/messages.
type mailpitSummary struct {
	ID      string        `json:"ID"`
	Subject string        `json:"Subject"`
	To      []mailpitAddr `json:"To"`
}

// mailpitMessage is GET /api/v1/message/{id}.
type mailpitMessage struct {
	ID      string        `json:"ID"`
	Subject string        `json:"Subject"`
	To      []mailpitAddr `json:"To"`
	Text    string        `json:"Text"`
	HTML    string        `json:"HTML"`
}

// mustExampleRecipient rejects any recipient outside the Mailpit-only
// @example.com inbox: a real domain here is a defect, fail loudly.
func mustExampleRecipient(t *testing.T, addr string) string {
	t.Helper()
	if !strings.HasSuffix(strings.ToLower(strings.TrimSpace(addr)), "@example.com") {
		t.Fatalf("recipient %q is not @example.com: e2e mail must never touch a real domain", addr)
	}
	return addr
}

func mailpitGET(t *testing.T, client *http.Client, path string, out any) {
	t.Helper()
	resp, err := client.Get(e2eAPIBase() + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("GET %s read: %v", path, err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200: %s", path, resp.StatusCode, body)
	}
	if err := json.Unmarshal(body, out); err != nil {
		t.Fatalf("GET %s decode: %v\n%s", path, err, body)
	}
}

func mailpitDELETE(t *testing.T, client *http.Client, path string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, e2eAPIBase()+path, nil)
	if err != nil {
		t.Fatalf("DELETE %s build: %v", path, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("DELETE %s: %v", path, err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE %s = %d, want 200", path, resp.StatusCode)
	}
}

func TestMailE2E(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode: Mailpit e2e needs the live dev stack")
	}

	smtpAddr := e2eSMTPAddr()
	conn, err := net.DialTimeout("tcp", smtpAddr, 3*time.Second)
	if err != nil {
		t.Skipf("Mailpit SMTP unreachable at %s: %v (start it with: docker compose up -d mailpit)", smtpAddr, err)
	}
	conn.Close()

	httpClient := &http.Client{Timeout: 10 * time.Second}
	var probe struct {
		Total int `json:"total"`
	}
	func() {
		defer func() {
			if recover() != nil {
				t.Skipf("Mailpit API unreachable at %s (start it with: docker compose up -d mailpit)", e2eAPIBase())
			}
		}()
		mailpitGET(t, httpClient, "/api/v1/messages", &probe)
	}()

	host, portStr, err := net.SplitHostPort(smtpAddr)
	if err != nil {
		t.Fatalf("MAILPIT_SMTP_ADDR %q must be host:port: %v", smtpAddr, err)
	}
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		t.Fatalf("MAILPIT_SMTP_ADDR %q port must be numeric: %v", smtpAddr, err)
	}

	// Nine flows through the domain template constructors — the same
	// vocabulary the enqueue hooks fan out (requested/approve/reject/cancel/
	// auto_cancel/reschedule/reminder/check_in/check_out). visit_requested
	// rides the staff leg only, so its flow targets the staff address. No
	// type stays excluded: the allowlist admits all nine lifecycle types.
	visit := domain.VisitRequest{
		VisitID:      e2eVisitCode,
		LocationName: "Kantor Cabang E2E",
		StartDate:    time.Now().Add(24 * time.Hour).Truncate(time.Second),
		EndDate:      time.Now().Add(26 * time.Hour).Truncate(time.Second),
	}
	e2eFlows := []struct {
		name string
		tpl  *domain.NotificationTemplate
		to   string
	}{
		{"requested", domain.CreatedNotification(e2eVisitCode), "e2e-staff@example.com"},
		{"approve", domain.TransitionNotification(domain.VisitStatusApproved, false, e2eVisitCode, ""), "e2e-vendor@example.com"},
		{"reject", domain.TransitionNotification(domain.VisitStatusRejected, false, e2eVisitCode, ""), "e2e-vendor@example.com"},
		{"cancel", domain.HumanCancelledNotification(e2eVisitCode, false, ""), "e2e-vendor@example.com"},
		{"auto_cancel", domain.TransitionNotification(domain.VisitStatusCancelled, true, e2eVisitCode, ""), "e2e-vendor@example.com"},
		{"reschedule", domain.RescheduledVendorNotification(e2eVisitCode, ""), "e2e-vendor@example.com"},
		{"reminder", domain.ReminderNotification(e2eVisitCode), "e2e-vendor@example.com"},
		{"check_in", domain.TransitionNotification(domain.VisitStatusVisiting, false, e2eVisitCode, ""), "e2e-staff@example.com"},
		{"check_out", domain.TransitionNotification(domain.VisitStatusCompleted, false, e2eVisitCode, ""), "e2e-staff@example.com"},
	}
	excluded := []*domain.NotificationTemplate{}

	wantSubjects := make(map[string]string, len(e2eFlows))
	for _, f := range e2eFlows {
		if f.tpl == nil {
			t.Fatalf("flow %s: template is nil, want a notice", f.name)
		}
		if !domain.EmailAllowed(f.tpl.Type) {
			t.Fatalf("flow %s: EmailAllowed(%q) = false, want true (allowlist regression)", f.name, f.tpl.Type)
		}
		mustExampleRecipient(t, f.to)
		subject, _, _ := domain.BuildEmail(visit, f.tpl)
		if subject == "" {
			t.Fatalf("flow %s: empty subject, want [THC-VMS] line", f.name)
		}
		if dup, clash := wantSubjects[subject]; clash {
			t.Fatalf("subject %q shared by flows %q and %q: subjects must be unique per flow", subject, dup, f.name)
		}
		wantSubjects[subject] = f.name
	}
	for _, tpl := range excluded {
		if tpl == nil {
			continue
		}
		if domain.EmailAllowed(tpl.Type) {
			t.Fatalf("EmailAllowed(%q) = true, want false: excluded types must never fan out", tpl.Type)
		}
	}

	// Clean slate, then wipe again on the way out: no e2e data survives.
	mailpitDELETE(t, httpClient, "/api/v1/messages")
	t.Cleanup(func() {
		client := &http.Client{Timeout: 10 * time.Second}
		req, err := http.NewRequest(http.MethodDelete, e2eAPIBase()+"/api/v1/messages", nil)
		if err != nil {
			return
		}
		if resp, err := client.Do(req); err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	})

	m, err := mailer.New(&config.Config{
		Mail: config.Mail{
			Enabled: true,
			Host:    host,
			Port:    port,
			From:    e2eFrom,
			Timeout: 30 * time.Second,
		},
	})
	if err != nil {
		t.Fatalf("mailer.New: %v", err)
	}
	ctx := context.Background()
	for _, f := range e2eFlows {
		subject, textBody, htmlBody := domain.BuildEmail(visit, f.tpl)
		if !strings.Contains(textBody, e2eVisitCode) {
			t.Fatalf("flow %s: text body lacks visit code %s", f.name, e2eVisitCode)
		}
		if err := m.Send(ctx, []string{f.to}, subject, textBody, htmlBody); err != nil {
			t.Fatalf("flow %s: Send = %v", f.name, err)
		}
	}
	// Close drains the queue: after it returns every flush has completed.
	if err := m.Close(); err != nil {
		t.Fatalf("Close (drain) = %v", err)
	}

	// Poll the Mailpit API: all nine must land.
	var summaries struct {
		Total    int              `json:"total"`
		Messages []mailpitSummary `json:"messages"`
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		mailpitGET(t, httpClient, "/api/v1/messages", &summaries)
		if summaries.Total == len(e2eFlows) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Mailpit holds %d messages, want exactly %d after 20s (lost or duplicated flush?)", summaries.Total, len(e2eFlows))
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Exactly the nine subjects, each once; zero of the excluded type.
	seen := make(map[string]int, len(e2eFlows))
	for _, s := range summaries.Messages {
		seen[s.Subject]++
		for _, to := range s.To {
			mustExampleRecipient(t, to.Address)
		}
	}
	for subject, flow := range wantSubjects {
		if seen[subject] != 1 {
			t.Errorf("subject %q (flow %s) seen %d times, want exactly once", subject, flow, seen[subject])
		}
	}
	for _, tpl := range excluded {
		subject, _, _ := domain.BuildEmail(visit, tpl)
		if seen[subject] != 0 {
			t.Errorf("excluded subject %q seen %d times, want ZERO (type %q must never email)", subject, seen[subject], tpl.Type)
		}
	}
	if len(seen) != len(e2eFlows) {
		t.Errorf("%d distinct subjects in Mailpit, want exactly %d (stray messages?)", len(seen), len(e2eFlows))
	}

	// Bodies carry the visit code (text or HTML part).
	for _, s := range summaries.Messages {
		var full mailpitMessage
		mailpitGET(t, httpClient, "/api/v1/message/"+s.ID, &full)
		if !strings.Contains(full.Text, e2eVisitCode) && !strings.Contains(full.HTML, e2eVisitCode) {
			t.Errorf("message %q: neither text nor HTML body contains visit code %s", s.Subject, e2eVisitCode)
		}
	}
}
