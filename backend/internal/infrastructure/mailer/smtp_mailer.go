// Package mailer is the async SMTP implementation of the domain Mailer port.
// It is the only place in the backend that talks to an SMTP server, so the
// retry policy, the TLS posture and the queue discipline are decided exactly
// once. Notifications are fire-and-forget: Send never blocks the caller, a
// bounded worker pool drains the queue with a fresh connection per flush,
// and Close drains what is queued before returning.
package mailer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	mail "github.com/wneessen/go-mail"

	"github.com/google/uuid"

	"thc-vms/backend/internal/config"
	"thc-vms/backend/internal/domain"
)

// Queue and worker budgets. The queue absorbs approval/check-in bursts without
// ever blocking an HTTP handler; three workers give parallel flushes while a
// per-flush dial keeps no connection open long enough for the server
// (Hostinger 421s on too many connections) to regard it as idle abuse.
const (
	defaultQueueSize = 100
	defaultWorkers   = 3
	// defaultClientTimeout bounds a single SMTP dial/read/write inside the
	// go-mail client. Delivery additionally runs under context.WithTimeout
	// per attempt (client timeout alone only bounds dial), so both knobs are
	// always armed.
	defaultClientTimeout = 30 * time.Second
	// defaultCloseTimeout bounds the graceful drain in Close.
	defaultCloseTimeout = 30 * time.Second
	// maxRetries is the number of re-delivery attempts after the first
	// failure. Only transient failures are retried; a permanent SMTP 5xx is
	// never retried.
	maxRetries = 3
	// defaultLogTimeout bounds one detached mail_log write. The write never
	// runs on the request hot path (enqueue spawns it, the worker owns the
	// verdict), so this is only a leak guard for a wedged database.
	defaultLogTimeout = 5 * time.Second
	// maxLogErrorChars caps the stored verdict error text so one verbose SMTP
	// transcript cannot bloat the row.
	maxLogErrorChars = 2000
)

// backoffs paces the three retries: 5s after the first failure, 10s after
// the second, 20s after the third. The attempt that exhausts the budget
// returns instead of sleeping a fourth time.
var backoffs = []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second}

// smtpCodeRe extracts the three-digit SMTP reply code so delivery failures
// can be classified without depending on any one library's error wording: a
// 4xx code is transient (retry), a 5xx code is permanent (never retry).
var smtpCodeRe = regexp.MustCompile(`\b([45])\d{2}\b`)

// sendFunc flushes one composed message. The production implementation dials
// a fresh SMTP connection per call; tests stub it to avoid the network.
type sendFunc func(ctx context.Context, msg *mail.Msg) error

// sleepFunc waits out a retry backoff, aborting early when ctx is done. The
// production implementation is a real timer; tests record the durations
// without sleeping.
type sleepFunc func(ctx context.Context, d time.Duration) error

// mailJob is one queued notification. Delivery is detached from the
// submitting request: a cancelled HTTP request must not silently drop a
// visit notification, so workers deliver under context.Background bounded
// per attempt by the configured mail timeout.
type mailJob struct {
	// id correlates the queued row with its sent/failed verdict. It is
	// client-generated so the enqueue path can hand it to the detached log
	// write without waiting for the database round-trip.
	id       domain.UUID
	template string
	to       []string
	// bcc carries the national overseers (super_admin incl. the hidden
	// dev-superadmin): hidden from the To recipients by the envelope, but
	// stored on the mail_log row so the back-office trail stays complete.
	bcc      []string
	subject  string
	textBody string
	htmlBody string
	// qrPNG/cid carry the optional inline team QR: when both are set the
	// PNG is embedded under the Content-ID the HTML references as
	// "cid:<cid>". Empty on every non-approval mail.
	qrPNG []byte
	cid   string
}

// SMTPMailer queues visit notifications and flushes them through a pool of
// workers, each dialing a fresh SMTP connection per message. The zero value
// is not usable; build it with New (production) or newSMTPMailer (tests).
type SMTPMailer struct {
	from string
	// fromName is the sender display name rendered as `"Name" <addr>`.
	// Empty means a bare address From.
	fromName      string
	timeout       time.Duration
	clientTimeout time.Duration
	newClient     func() (*mail.Client, error)

	mu     sync.RWMutex
	queue  chan mailJob
	closed bool

	// dryRun logs the rendered subject/recipient instead of dialing. It is
	// set once from config at construction and never toggled afterwards,
	// so workers observe it without synchronization.
	dryRun bool

	// logs is the optional mail_log writer behind the delivery verdicts
	// (migration 000030). Nil disables verdict tracking: the send path is
	// byte-for-byte the old one. Wired once via WithMailLog before the
	// first Send, never toggled afterwards, so no synchronization is needed.
	logs domain.MailLogWriter

	wg           sync.WaitGroup
	send         sendFunc
	sleep        sleepFunc
	closeTimeout time.Duration
	dropped      atomic.Int64
}

// compile-time proof that the adapter satisfies the domain Mailer port.
var _ domain.Mailer = (*SMTPMailer)(nil)

// compile-time proof that the adapter satisfies the optional templated port.
var _ domain.TemplatedMailer = (*SMTPMailer)(nil)

// New builds the adapter from configuration, mirroring the MinIO adapter's
// fail-fast shape: a half-configured mailer must fail at startup, never at
// the first notification. A nil config and an enabled mailer without a host
// are both refused. An empty From falls back to User here, at
// construction-read time, never in config.
func New(cfg *config.Config) (*SMTPMailer, error) {
	if cfg == nil {
		return nil, errors.New("mailer: config is required")
	}
	mc := cfg.Mail
	if mc.Enabled && mc.Host == "" {
		return nil, errors.New("mailer: SMTP_HOST is required when SMTP_ENABLED=true: refusing to run a half-configured mailer")
	}
	from := mc.From
	if from == "" {
		from = mc.User
	}
	timeout := mc.Timeout
	if timeout <= 0 {
		timeout = defaultClientTimeout
	}
	m := newSMTPMailer(from, timeout, defaultClientTimeout, defaultQueueSize, defaultWorkers, nil, realSleep)
	m.fromName = mc.FromName
	m.dryRun = mc.DryRun
	m.newClient = func() (*mail.Client, error) {
		return buildClient(mc.Host, mc.Port, mc.User, mc.Password, defaultClientTimeout)
	}
	return m, nil
}

// buildClient assembles the go-mail client for one flush. Port 465 uses
// implicit TLS (WithSSL); port 587 uses STARTTLS under a mandatory TLS
// policy; any other port is plain dev SMTP (Mailpit :1025: NoTLS, auth only
// when credentials are set). The library defaults the TLS config to
// ServerName=host and TLS 1.2 minimum; nothing here ever sets
// InsecureSkipVerify, and the password travels only inside the client,
// never into a log line.
func buildClient(host string, port int, user, password string, clientTimeout time.Duration) (*mail.Client, error) {
	opts := []mail.Option{
		mail.WithPort(port),
		mail.WithTimeout(clientTimeout),
	}
	switch port {
	case 465:
		opts = append(opts,
			mail.WithSMTPAuth(mail.SMTPAuthPlain),
			mail.WithUsername(user),
			mail.WithPassword(password),
			mail.WithSSL(),
		)
	case 587:
		opts = append(opts,
			mail.WithSMTPAuth(mail.SMTPAuthPlain),
			mail.WithUsername(user),
			mail.WithPassword(password),
			mail.WithTLSPolicy(mail.TLSMandatory),
		)
	default:
		opts = append(opts, mail.WithTLSPolicy(mail.NoTLS))
		if user == "" && password == "" {
			opts = append(opts, mail.WithSMTPAuth(mail.SMTPAuthNoAuth))
		} else {
			opts = append(opts,
				mail.WithSMTPAuth(mail.SMTPAuthPlain),
				mail.WithUsername(user),
				mail.WithPassword(password),
			)
		}
	}
	return mail.NewClient(host, opts...)
}

// newSMTPMailer assembles a mailer and starts workers background goroutines.
// A nil send falls back to the live per-flush dial; tests pass a stub and
// pass 0 workers when they drive deliver directly.
func newSMTPMailer(from string, timeout, clientTimeout time.Duration, queueSize, workers int, send sendFunc, sleep sleepFunc) *SMTPMailer {
	if timeout <= 0 {
		timeout = defaultClientTimeout
	}
	if clientTimeout <= 0 {
		clientTimeout = defaultClientTimeout
	}
	if queueSize <= 0 {
		queueSize = defaultQueueSize
	}
	m := &SMTPMailer{
		from:          from,
		timeout:       timeout,
		clientTimeout: clientTimeout,
		queue:         make(chan mailJob, queueSize),
		send:          send,
		sleep:         sleep,
		closeTimeout:  defaultCloseTimeout,
	}
	if m.send == nil {
		m.send = m.defaultSend
	}
	if m.sleep == nil {
		m.sleep = realSleep
	}
	for i := 0; i < workers; i++ {
		m.wg.Add(1)
		go m.run()
	}
	return m
}

// WithMailLog wires the mail_log writer behind the delivery verdicts and
// returns the mailer for chained wiring at the composition root. A nil
// writer disables verdict tracking.
func (m *SMTPMailer) WithMailLog(logs domain.MailLogWriter) *SMTPMailer {
	m.logs = logs
	return m
}

// logEnabled reports whether a verdict write is due: a writer is wired and
// the adapter is really dialing. Dry-run skips logging so CI legs without
// Mailpit never accumulate phantom queued rows for mails that were never
// sent.
func (m *SMTPMailer) logEnabled() bool {
	return m != nil && m.logs != nil && !m.dryRun
}

// Send enqueues one notification and returns immediately. A full queue never
// blocks the caller: the message is dropped, a warning is logged (recipient
// and subject only, never credentials) and the dropped counter is bumped.
// Sending after Close is refused with an error.
func (m *SMTPMailer) Send(_ context.Context, to []string, subject, textBody, htmlBody string) error {
	return m.enqueue(to, nil, "", subject, textBody, htmlBody, nil, "")
}

// SendBcc enqueues one notification with the direct owners in To and the
// overseers in Bcc, mirroring Send otherwise.
func (m *SMTPMailer) SendBcc(_ context.Context, to, bcc []string, subject, textBody, htmlBody string) error {
	return m.enqueue(to, bcc, "", subject, textBody, htmlBody, nil, "")
}

// SendWithTeamQR enqueues one notification with its inline team QR attached
// and returns immediately, mirroring Send: a full queue drops (never blocks)
// and sending after Close is refused.
func (m *SMTPMailer) SendWithTeamQR(_ context.Context, to []string, subject, textBody, htmlBody string, qrPNG []byte, cid string) error {
	return m.enqueue(to, nil, "", subject, textBody, htmlBody, qrPNG, cid)
}

// SendTemplated enqueues one lifecycle notification carrying its template
// label for the mail_log row, mirroring Send otherwise.
func (m *SMTPMailer) SendTemplated(_ context.Context, template string, to []string, subject, textBody, htmlBody string) error {
	return m.enqueue(to, nil, template, subject, textBody, htmlBody, nil, "")
}

// SendTemplatedBcc enqueues one lifecycle notification with the direct
// owners in To and the overseers in Bcc, carrying its template label for
// the mail_log row, mirroring SendTemplated otherwise.
func (m *SMTPMailer) SendTemplatedBcc(_ context.Context, template string, to, bcc []string, subject, textBody, htmlBody string) error {
	return m.enqueue(to, bcc, template, subject, textBody, htmlBody, nil, "")
}

// SendTemplatedWithTeamQR enqueues one lifecycle notification with its inline
// team QR and its template label, mirroring SendWithTeamQR otherwise.
func (m *SMTPMailer) SendTemplatedWithTeamQR(_ context.Context, template string, to []string, subject, textBody, htmlBody string, qrPNG []byte, cid string) error {
	return m.enqueue(to, nil, template, subject, textBody, htmlBody, qrPNG, cid)
}

// enqueue validates the recipients, queues one job and records its queued
// row from a detached goroutine: the caller never waits on the database, so
// the HTTP hot path keeps the old non-blocking shape. A log failure only
// warns; the queued send stands regardless. Bcc recipients ride along in
// the envelope but never appear in To; at least one of To/Bcc must be
// non-empty.
func (m *SMTPMailer) enqueue(to, bcc []string, template, subject, textBody, htmlBody string, qrPNG []byte, cid string) error {
	recipients := trimRecipients(to)
	hidden := trimRecipients(bcc)
	if len(recipients) == 0 && len(hidden) == 0 {
		return fmt.Errorf("mailer: at least one recipient is required: %w", domain.ErrValidation)
	}
	job := mailJob{id: domain.UUID(uuid.NewString()), template: template, to: recipients, bcc: hidden, subject: subject, textBody: textBody, htmlBody: htmlBody, qrPNG: qrPNG, cid: cid}
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed {
		return errors.New("mailer: mailer is closed")
	}
	select {
	case m.queue <- job:
		if m.logEnabled() {
			go m.logQueued(job)
		}
		return nil
	default:
		dropped := m.dropped.Add(1)
		slog.Warn("mailer: queue full, dropping email", "to", to, "bcc_count", len(hidden), "subject", subject, "dropped_total", dropped)
		return nil
	}
}

// logQueued records the accepted send. It runs on a detached goroutine with
// its own timeout so a slow database can never block the enqueueing request;
// a failure only warns because the queued send must stand regardless.
func (m *SMTPMailer) logQueued(job mailJob) {
	if !m.logEnabled() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), defaultLogTimeout)
	defer cancel()
	entry := domain.MailLog{
		ID: job.id, Recipients: job.to, Bcc: job.bcc, Subject: job.subject, Template: job.template,
		Status: domain.MailLogQueued, CreatedAt: time.Now().UTC(),
	}
	if job.textBody != "" {
		body := job.textBody
		entry.TextBody = &body
	}
	if err := m.logs.InsertQueued(ctx, entry); err != nil {
		slog.Warn("mailer: mail_log queued insert failed", "to", job.to, "subject", job.subject, "err", err)
	}
}

// logVerdict records the final verdict (sent, or failed with the attempt
// count and error text). It runs on the worker, never on the request hot
// path; a failure only warns.
func (m *SMTPMailer) logVerdict(job mailJob, status domain.MailLogStatus, attempts int, err error) {
	if !m.logEnabled() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), defaultLogTimeout)
	defer cancel()
	entry := domain.MailLog{
		ID: job.id, Recipients: job.to, Bcc: job.bcc, Subject: job.subject, Template: job.template,
		Status: status, Attempts: attempts, CreatedAt: time.Now().UTC(),
	}
	if job.textBody != "" {
		body := job.textBody
		entry.TextBody = &body
	}
	if err != nil {
		msg := truncateLogError(err)
		entry.Error = &msg
	}
	if uerr := m.logs.RecordVerdict(ctx, entry); uerr != nil {
		slog.Warn("mailer: mail_log verdict update failed", "status", string(status), "err", uerr)
	}
}

// truncateLogError renders the verdict error text within the column budget.
func truncateLogError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if len([]rune(msg)) > maxLogErrorChars {
		msg = string([]rune(msg)[:maxLogErrorChars])
	}
	return msg
}

// trimRecipients drops blank entries and copies the slice so later caller
// mutation cannot change a queued job.
func trimRecipients(to []string) []string {
	recipients := make([]string, 0, len(to))
	for _, addr := range to {
		if trimmed := strings.TrimSpace(addr); trimmed != "" {
			recipients = append(recipients, trimmed)
		}
	}
	return recipients
}

// Dropped reports how many notifications were shed under a full queue.
func (m *SMTPMailer) Dropped() int64 {
	return m.dropped.Load()
}

// QueueDepth reports how many notifications are currently waiting in the
// queue. len on a channel is safe for concurrent use, so no lock is taken;
// the value is a point-in-time sample for the /settings/system probe only,
// never a flow-control signal. It changes nothing about the send path.
func (m *SMTPMailer) QueueDepth() int {
	if m == nil {
		return 0
	}
	return len(m.queue)
}

// Close stops intake, drains every queued notification through the workers,
// and returns. The drain is bounded: it gives up with an error after
// closeTimeout rather than hanging shutdown forever. No goroutine survives
// a returned Close.
func (m *SMTPMailer) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	close(m.queue)
	m.mu.Unlock()

	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	timer := time.NewTimer(m.closeTimeout)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-timer.C:
		return fmt.Errorf("mailer: close timed out after %s: workers did not drain", m.closeTimeout)
	}
}

// run is one worker: it delivers queued jobs until Close closes the queue,
// which drains every buffered job before the range ends.
func (m *SMTPMailer) run() {
	defer m.wg.Done()
	for job := range m.queue {
		m.deliver(context.Background(), job)
	}
}

// deliver flushes one job with transient-only retry: up to maxRetries
// re-deliveries paced by backoffs. A permanent failure (SMTP 5xx, cancelled
// context, unbuildable message) is logged once and never retried. The final
// verdict (sent, or failed with the attempt count and error text) is recorded
// to mail_log best-effort; the retry discipline itself is unchanged.
func (m *SMTPMailer) deliver(parent context.Context, job mailJob) {
	msg, err := m.compose(job)
	if err != nil {
		slog.Error("mailer: cannot compose email, dropping", "to", job.to, "error", err)
		m.logVerdict(job, domain.MailLogFailed, 0, err)
		return
	}
	// Dry-run renders and validates exactly like production but never dials:
	// the composed subject/recipient are logged for CI legs without Mailpit.
	if m.dryRun {
		slog.Info("mailer: dry-run, skipping dial", "to", job.to, "subject", job.subject)
		return
	}
	for attempt := 0; ; attempt++ {
		if err := m.send(parent, msg); err == nil {
			m.logVerdict(job, domain.MailLogSent, attempt+1, nil)
			return
		} else if attempt >= maxRetries || !isTransient(err) {
			slog.Error("mailer: delivery failed", "to", job.to, "attempt", attempt+1, "error", err)
			m.logVerdict(job, domain.MailLogFailed, attempt+1, err)
			return
		} else {
			backoff := backoffs[attempt]
			slog.Warn("mailer: transient failure, retrying", "to", job.to, "attempt", attempt+1, "backoff", backoff, "error", err)
			if serr := m.sleep(parent, backoff); serr != nil {
				m.logVerdict(job, domain.MailLogFailed, attempt+1, err)
				return
			}
		}
	}
}

// defaultSend dials a fresh SMTP connection, flushes one message under both
// the client timeout and a per-attempt context timeout, and closes the
// connection. One connection per flush means no connection is ever held
// open long enough to attract the server's too-many-connections 421.
func (m *SMTPMailer) defaultSend(parent context.Context, msg *mail.Msg) error {
	if m.newClient == nil {
		return errors.New("mailer: no SMTP client factory configured")
	}
	client, err := m.newClient()
	if err != nil {
		return fmt.Errorf("mailer: create SMTP client: %w", err)
	}
	defer func() {
		_ = client.Close()
	}()
	ctx, cancel := context.WithTimeout(parent, m.timeout)
	defer cancel()
	if err := client.DialAndSendWithContext(ctx, msg); err != nil {
		return fmt.Errorf("mailer: dial and send: %w", err)
	}
	return nil
}

// compose renders one queued job into a go-mail message sent as From. A text
// body is always set; a non-empty HTML body rides along as the MIME
// alternative. Address errors surface here, before any network I/O, and are
// therefore permanent by construction.
func (m *SMTPMailer) compose(job mailJob) (*mail.Msg, error) {
	msg := mail.NewMsg()
	if m.fromName != "" {
		if err := msg.FromFormat(m.fromName, m.from); err != nil {
			return nil, fmt.Errorf("mailer: invalid from address: %w", err)
		}
	} else if err := msg.From(m.from); err != nil {
		return nil, fmt.Errorf("mailer: invalid from address: %w", err)
	}
	if err := msg.To(job.to...); err != nil {
		return nil, fmt.Errorf("mailer: invalid recipient: %w", err)
	}
	if len(job.bcc) > 0 {
		if err := msg.Bcc(job.bcc...); err != nil {
			return nil, fmt.Errorf("mailer: invalid bcc recipient: %w", err)
		}
	}
	msg.Subject(job.subject)
	msg.SetBodyString(mail.TypeTextPlain, job.textBody)
	if job.htmlBody != "" {
		msg.AddAlternativeString(mail.TypeTextHTML, job.htmlBody)
	}
	// The approval team QR rides along as the one inline attachment the
	// HTML references through "cid:<cid>". Both halves are set together by
	// SendWithTeamQR; a half-set job keeps the text fallback (the
	// Kode-kunjungan row) instead of embedding a dangling reference.
	if len(job.qrPNG) > 0 && job.cid != "" {
		msg.EmbedReadSeeker("team-qr.png", bytes.NewReader(job.qrPNG), mail.WithFileContentID(job.cid))
	}
	return msg, nil
}

// isTransient reports whether a delivery failure is worth retrying. The
// go-mail SendError already carries the server's verdict (its IsTemp mirrors
// the 4xx/5xx class), so it is authoritative when present. Otherwise the
// reply code embedded in the message decides: 4xx retries, 5xx never does.
// Network timeouts, EOFs and reset/refused connections are transient; a
// cancelled context is not. Anything unrecognised retries: the attempts are
// bounded by maxRetries, and an unknown send-path failure is far more likely
// to be network weather than a message the server has permanently refused.
func isTransient(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	var sendErr *mail.SendError
	if errors.As(err, &sendErr) {
		return sendErr.IsTemp()
	}
	if code := smtpCodeRe.FindStringSubmatch(err.Error()); code != nil {
		return code[1] == "4"
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	if os.IsTimeout(err) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	msg := strings.ToLower(err.Error())
	for _, transient := range []string{
		"connection reset",
		"broken pipe",
		"connection refused",
		"use of closed network connection",
	} {
		if strings.Contains(msg, transient) {
			return true
		}
	}
	return true
}

// realSleep waits out a backoff, aborting early when the delivery context
// is done.
func realSleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
