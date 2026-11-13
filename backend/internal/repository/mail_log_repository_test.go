package repository

import (
	"testing"

	"github.com/google/uuid"

	"thc-vms/backend/internal/domain"
)

// newMailLogEntry stages one queued verdict row with a fresh id.
func newMailLogEntry(template, subject string, to ...string) domain.MailLog {
	body := "teks diagnosis " + subject
	return domain.MailLog{
		ID:         domain.UUID(uuid.NewString()),
		Recipients: to,
		Subject:    subject,
		Template:   template,
		TextBody:   &body,
	}
}

// sentVerdictOf projects the successful verdict of a queued entry.
func sentVerdictOf(e domain.MailLog, attempts int) domain.MailLog {
	return domain.MailLog{
		ID: e.ID, Recipients: e.Recipients, Bcc: e.Bcc, Subject: e.Subject, Template: e.Template,
		TextBody: e.TextBody, Status: domain.MailLogSent, Attempts: attempts,
	}
}

// TestMailLog_QueuedThenSent membuktikan transisi queued→sent tercatat
// lengkap: penerima, templat, attempts, sent_at terisi, error null.
func TestMailLog_QueuedThenSent(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	r := NewMailLogRepository(pool)

	entry := newMailLogEntry("visit_approved", "[THC-VMS] Kunjungan Disetujui", "tek@vendor.local")
	entry.Bcc = []string{"bos@thc.id"}
	if err := r.InsertQueued(ctx, entry); err != nil {
		t.Fatalf("InsertQueued = %v", err)
	}
	items, total, err := r.List(ctx, domain.MailLogFilter{})
	if err != nil {
		t.Fatalf("List = %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("total=%d items=%d, want 1/1", total, len(items))
	}
	if len(items[0].Bcc) != 1 || items[0].Bcc[0] != "bos@thc.id" {
		t.Fatalf("bcc = %v, want [bos@thc.id] already on the queued row", items[0].Bcc)
	}
	if items[0].Status != domain.MailLogQueued || items[0].SentAt != nil {
		t.Fatalf("row = %+v, want queued tanpa sent_at", items[0])
	}
	if len(items[0].Recipients) != 1 || items[0].Recipients[0] != "tek@vendor.local" {
		t.Fatalf("recipients = %v, want [tek@vendor.local]", items[0].Recipients)
	}

	if err := r.RecordVerdict(ctx, sentVerdictOf(entry, 1)); err != nil {
		t.Fatalf("RecordVerdict = %v", err)
	}
	got, err := r.FindByID(ctx, entry.ID)
	if err != nil {
		t.Fatalf("FindByID = %v", err)
	}
	if got.Status != domain.MailLogSent || got.Attempts != 1 || got.Error != nil || got.SentAt == nil {
		t.Fatalf("row = %+v, want sent attempts 1 tanpa error + sent_at", got)
	}
	if got.Template != "visit_approved" || got.Subject != entry.Subject {
		t.Fatalf("row = %+v, want templat+subjek utuh", got)
	}
	if len(got.Bcc) != 1 || got.Bcc[0] != "bos@thc.id" {
		t.Fatalf("row bcc = %v, want [bos@thc.id] surviving the verdict upsert", got.Bcc)
	}
}

// TestMailLog_FailedKeepsErrorText membuktikan verdict failed menyimpan teks
// error (kasus rate-limit 451) beserta attempts yang sudah berjalan.
func TestMailLog_FailedKeepsErrorText(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	r := NewMailLogRepository(pool)

	entry := newMailLogEntry("visit_reminder", "[THC-VMS] Pengingat", "a@x")
	if err := r.InsertQueued(ctx, entry); err != nil {
		t.Fatalf("InsertQueued = %v", err)
	}
	msg := "451 4.3.0 Greylisted, try again later"
	failed := sentVerdictOf(entry, 4)
	failed.Status = domain.MailLogFailed
	failed.Error = &msg
	if err := r.RecordVerdict(ctx, failed); err != nil {
		t.Fatalf("RecordVerdict = %v", err)
	}
	got, err := r.FindByID(ctx, entry.ID)
	if err != nil {
		t.Fatalf("FindByID = %v", err)
	}
	if got.Status != domain.MailLogFailed || got.Attempts != 4 {
		t.Fatalf("row = %+v, want failed attempts 4", got)
	}
	if got.Error == nil || *got.Error != msg {
		t.Fatalf("error = %v, want %q tersimpan", got.Error, msg)
	}
}

// TestMailLog_VerdictBeforeQueuedKeepsFullRow membuktikan balapan
// verdict-vs-queued tak menghilangkan data: verdict lebih dulu tetap
// meninggalkan baris lengkap, insert queued susulan menjadi no-op.
func TestMailLog_VerdictBeforeQueuedKeepsFullRow(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	r := NewMailLogRepository(pool)

	entry := newMailLogEntry("visit_check_in", "[THC-VMS] Check-in", "b@x")
	if err := r.RecordVerdict(ctx, sentVerdictOf(entry, 2)); err != nil {
		t.Fatalf("RecordVerdict = %v", err)
	}
	if err := r.InsertQueued(ctx, entry); err != nil {
		t.Fatalf("InsertQueued susulan = %v, want no-op nil", err)
	}
	got, err := r.FindByID(ctx, entry.ID)
	if err != nil {
		t.Fatalf("FindByID = %v", err)
	}
	if got.Status != domain.MailLogSent || len(got.Recipients) != 1 || got.Attempts != 2 {
		t.Fatalf("row = %+v, want sent lengkap (bukan stub kosong)", got)
	}
	if err := r.InsertQueued(ctx, entry); err != nil {
		t.Fatalf("InsertQueued ganda = %v, want nil", err)
	}
}

// TestMailLog_ListFilterAndPagination membuktikan filter status + {total,
// page, limit} mengikuti input yang dinormalisasi.
func TestMailLog_ListFilterAndPagination(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	ctx := testContext(t)
	r := NewMailLogRepository(pool)

	sent := newMailLogEntry("visit_approved", "s1", "a@x")
	failed := newMailLogEntry("visit_rejected", "s2", "b@x")
	queued := newMailLogEntry("visit_reminder", "s3", "c@x")
	for _, e := range []domain.MailLog{sent, failed, queued} {
		if err := r.InsertQueued(ctx, e); err != nil {
			t.Fatalf("InsertQueued = %v", err)
		}
	}
	if err := r.RecordVerdict(ctx, sentVerdictOf(sent, 1)); err != nil {
		t.Fatalf("RecordVerdict sent = %v", err)
	}
	msg := "550 5.1.1 Rejected"
	bad := sentVerdictOf(failed, 1)
	bad.Status = domain.MailLogFailed
	bad.Error = &msg
	if err := r.RecordVerdict(ctx, bad); err != nil {
		t.Fatalf("RecordVerdict failed = %v", err)
	}

	status := domain.MailLogSent
	items, total, err := r.List(ctx, domain.MailLogFilter{Status: &status})
	if err != nil {
		t.Fatalf("List sent = %v", err)
	}
	if total != 1 || len(items) != 1 || items[0].ID != sent.ID {
		t.Fatalf("filter sent: total=%d items=%v, want hanya baris sent", total, items)
	}

	failedStatus := domain.MailLogFailed
	items, total, err = r.List(ctx, domain.MailLogFilter{Status: &failedStatus, Page: 1, Limit: 1})
	if err != nil {
		t.Fatalf("List failed = %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("filter failed: total=%d items=%d, want 1/1", total, len(items))
	}

	items, total, err = r.List(ctx, domain.MailLogFilter{Page: 2, Limit: 2})
	if err != nil {
		t.Fatalf("List page 2 = %v", err)
	}
	if total != 3 || len(items) != 1 {
		t.Fatalf("page 2 limit 2: total=%d items=%d, want 3/1", total, len(items))
	}
}

// TestMailLog_FindMissingIsNotFound membuktikan id asing menjawab 404
// NOT_FOUND ("Log email tidak ditemukan.").
func TestMailLog_FindMissingIsNotFound(t *testing.T) {
	pool := testPool(t)
	resetTables(t, pool)
	r := NewMailLogRepository(pool)

	_, err := r.FindByID(testContext(t), domain.UUID(uuid.NewString()))
	requireErrIs(t, err, domain.ErrNotFound, "FindByID asing")
}
