package handlers_test

import (
	"context"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"thc-vms/backend/internal/delivery/http/handlers"
	"thc-vms/backend/internal/domain"
	"thc-vms/backend/internal/usecase/settings"
)

// fakeProbeVersions adalah AppliedVersionSource dalam memori: mengembalikan
// fixture yang diberikan tanpa menyentuh database.
type fakeProbeVersions struct {
	v   *int
	err error
}

func (f *fakeProbeVersions) AppliedMaxVersion(_ context.Context) (*int, error) {
	return f.v, f.err
}

// fakeProbeStats adalah MailQueueStats dalam memori.
type fakeProbeStats struct {
	depth   int
	dropped int64
}

func (f *fakeProbeStats) QueueDepth() int { return f.depth }
func (f *fakeProbeStats) Dropped() int64  { return f.dropped }

// fakeProbeMailer merekam Send seperti domain.FakeMailer sekaligus membawa
// statistik antrean agar satu fake melayani kedua seam probe.
type fakeProbeMailer struct {
	calls   []domain.MailCall
	err     error
	depth   int
	dropped int64
}

func (f *fakeProbeMailer) Send(_ context.Context, to []string, subject, textBody, htmlBody string) error {
	f.calls = append(f.calls, domain.MailCall{To: to, Subject: subject, TextBody: textBody, HTMLBody: htmlBody})
	return f.err
}

func (f *fakeProbeMailer) SendBcc(_ context.Context, to, bcc []string, subject, textBody, htmlBody string) error {
	f.calls = append(f.calls, domain.MailCall{To: to, Bcc: bcc, Subject: subject, TextBody: textBody, HTMLBody: htmlBody})
	return f.err
}

func (f *fakeProbeMailer) SendWithTeamQR(_ context.Context, to []string, subject, textBody, htmlBody string, qrPNG []byte, cid string) error {
	f.calls = append(f.calls, domain.MailCall{To: to, Subject: subject, TextBody: textBody, HTMLBody: htmlBody, QRPNG: qrPNG, QRCID: cid})
	return f.err
}

func (f *fakeProbeMailer) QueueDepth() int { return f.depth }
func (f *fakeProbeMailer) Dropped() int64  { return f.dropped }

// fakeProbeUsers mengembalikan satu alamat tetap untuk pemanggil mana pun.
type fakeProbeUsers struct {
	email string
	err   error
}

func (f *fakeProbeUsers) FindByID(_ context.Context, id domain.UUID) (domain.User, error) {
	if f.err != nil {
		return domain.User{}, f.err
	}
	return domain.User{ID: id, Email: f.email}, nil
}

// fakeProbeAudit mencatat Append best-effort milik test-mail.
type fakeProbeAudit struct {
	entries []domain.AuditEntry
	err     error
}

func (f *fakeProbeAudit) Append(_ context.Context, entry domain.AuditEntry) (domain.AuditLog, error) {
	if f.err != nil {
		return domain.AuditLog{}, f.err
	}
	f.entries = append(f.entries, entry)
	return domain.AuditLog{}, nil
}

func (f *fakeProbeAudit) List(_ context.Context, _ domain.AuditFilter) ([]domain.AuditLog, int64, error) {
	return nil, 0, nil
}

func probeInt(v int) *int { return &v }

// newProbeHandler merakit SettingsHandler dengan semua seam probe terisi
// kecuali yang diberikan nil (untuk kasus 503 tanpa mailer).
func newProbeHandler(dbVersion *int, repoVersion int, mailer *fakeProbeMailer) (*handlers.SettingsHandler, *fakeProbeMailer, *fakeProbeAudit) {
	if mailer == nil {
		mailer = &fakeProbeMailer{}
	}
	audit := &fakeProbeAudit{}
	svc := settings.NewService(&fakeSettingsRepo{}).
		WithSystem(&fakeProbeVersions{v: dbVersion}, &fakeProbeStats{depth: 2, dropped: 1}, repoVersion)
	h := handlers.NewSettingsHandler(svc).
		WithUsers(&fakeProbeUsers{email: "owner@thc.local"}).
		WithMailer(mailer).
		WithAudit(audit)
	return h, mailer, audit
}

// systemProbeData mencerminkan systemStatusWire milik handler.
type systemProbeData struct {
	DBVersion   *int `json:"dbVersion"`
	RepoVersion int  `json:"repoVersion"`
	InSync      bool `json:"inSync"`
	Mailer      struct {
		QueueDepth int   `json:"queueDepth"`
		Dropped    int64 `json:"dropped"`
	} `json:"mailer"`
}

// TestSettingsSystem_Probe200AndShape membuktikan GET /settings/system
// menjawab 200 dengan bentuk {dbVersion, repoVersion, inSync,
// mailer:{queueDepth, dropped}} dari fixture.
func TestSettingsSystem_Probe200AndShape(t *testing.T) {
	h, _, _ := newProbeHandler(probeInt(26), 26, nil)
	engine := gin.New()
	engine.Use(withActor(domain.RoleDevSuperAdmin, ""))
	engine.GET("/settings/system", h.System)

	rec := serveJSON(engine, "GET", "/settings/system", "")
	mustStatus(t, rec, 200)
	data := decodeData[systemProbeData](t, mustSuccess(t, rec))
	if data.DBVersion == nil || *data.DBVersion != 26 {
		t.Fatalf("dbVersion = %v, want 26", data.DBVersion)
	}
	if data.RepoVersion != 26 {
		t.Fatalf("repoVersion = %d, want 26", data.RepoVersion)
	}
	if !data.InSync {
		t.Fatal("inSync = false, want true saat dbVersion == repoVersion")
	}
	if data.Mailer.QueueDepth != 2 || data.Mailer.Dropped != 1 {
		t.Fatalf("mailer = %+v, want {2 1}", data.Mailer)
	}
}

// TestSettingsSystem_NullDBAndOutOfSync membuktikan dbVersion null saat
// belum ada migrasi teraplikasi dan inSync false saat versi berbeda.
func TestSettingsSystem_NullDBAndOutOfSync(t *testing.T) {
	h, _, _ := newProbeHandler(nil, 26, nil)
	engine := gin.New()
	engine.Use(withActor(domain.RoleDevSuperAdmin, ""))
	engine.GET("/settings/system", h.System)

	rec := serveJSON(engine, "GET", "/settings/system", "")
	mustStatus(t, rec, 200)
	data := decodeData[systemProbeData](t, mustSuccess(t, rec))
	if data.DBVersion != nil {
		t.Fatalf("dbVersion = %d, want null", *data.DBVersion)
	}
	if data.InSync {
		t.Fatal("inSync = true, want false saat dbVersion null")
	}

	h2, _, _ := newProbeHandler(probeInt(25), 26, nil)
	engine2 := gin.New()
	engine2.Use(withActor(domain.RoleDevSuperAdmin, ""))
	engine2.GET("/settings/system", h2.System)
	rec2 := serveJSON(engine2, "GET", "/settings/system", "")
	data2 := decodeData[systemProbeData](t, mustSuccess(t, rec2))
	if data2.DBVersion == nil || *data2.DBVersion != 25 || data2.InSync {
		t.Fatalf("got %+v, want dbVersion 25 dan inSync false", data2)
	}
}

// TestSettingsSystem_RoleGate membuktikan super_admin biasa, admin,
// security, dan vendor semuanya 403 di kedua probe (hanya dev-superadmin
// yang lolos), dan penelepon anonim 401.
func TestSettingsSystem_RoleGate(t *testing.T) {
	for _, role := range []domain.RoleName{
		domain.RoleSuperAdmin, domain.RoleAdmin, domain.RoleSecurity, domain.RoleVendor,
	} {
		h, _, _ := newProbeHandler(probeInt(26), 26, nil)
		engine := gin.New()
		engine.Use(withActor(role, "loc-1"))
		engine.GET("/settings/system", h.System)
		engine.POST("/settings/test-mail", h.TestMail)

		if rec := serveJSON(engine, "GET", "/settings/system", ""); rec.Code != 403 {
			t.Fatalf("GET role %s: status = %d, want 403", role, rec.Code)
		}
		if rec := serveJSON(engine, "POST", "/settings/test-mail", "{}"); rec.Code != 403 {
			t.Fatalf("POST role %s: status = %d, want 403", role, rec.Code)
		}
	}

	h, _, _ := newProbeHandler(probeInt(26), 26, nil)
	anon := gin.New()
	anon.GET("/settings/system", h.System)
	anon.POST("/settings/test-mail", h.TestMail)
	if rec := serveJSON(anon, "GET", "/settings/system", ""); rec.Code != 401 {
		t.Fatalf("GET anonim: status = %d, want 401", rec.Code)
	}
	if rec := serveJSON(anon, "POST", "/settings/test-mail", "{}"); rec.Code != 401 {
		t.Fatalf("POST anonim: status = %d, want 401", rec.Code)
	}
}

// TestSettingsTestMail_SendsOnlyToCaller membuktikan POST /settings/test-mail
// mengirim tepat satu email ke inbox pemanggil (isi body "to" milik penyerang
// diabaikan), bertanda [EMAIL TES], dan menulis baris audit.
func TestSettingsTestMail_SendsOnlyToCaller(t *testing.T) {
	mailer := &fakeProbeMailer{}
	h, _, audit := newProbeHandler(probeInt(26), 26, mailer)
	engine := gin.New()
	engine.Use(withActor(domain.RoleDevSuperAdmin, ""))
	engine.POST("/settings/test-mail", h.TestMail)

	rec := serveJSON(engine, "POST", "/settings/test-mail", `{"to":"evil@lain.example"}`)
	mustStatus(t, rec, 200)
	env := mustSuccess(t, rec)
	var result struct {
		Sent bool   `json:"sent"`
		To   string `json:"to"`
	}
	result = decodeData[struct {
		Sent bool   `json:"sent"`
		To   string `json:"to"`
	}](t, env)
	if !result.Sent || result.To != "owner@thc.local" {
		t.Fatalf("hasil = %+v, want {true owner@thc.local}", result)
	}
	if len(mailer.calls) != 1 {
		t.Fatalf("mail terkirim = %d, want 1", len(mailer.calls))
	}
	call := mailer.calls[0]
	if len(call.To) != 1 || call.To[0] != "owner@thc.local" {
		t.Fatalf("penerima = %v, want hanya [owner@thc.local]", call.To)
	}
	if !strings.Contains(call.Subject, "[EMAIL TES]") {
		t.Fatalf("subjek = %q, want memuat [EMAIL TES]", call.Subject)
	}
	if !strings.Contains(call.HTMLBody, "[EMAIL TES]") {
		t.Fatal("bodi HTML tidak memuat penanda [EMAIL TES]")
	}
	if len(audit.entries) != 1 {
		t.Fatalf("baris audit = %d, want 1", len(audit.entries))
	}
	entry := audit.entries[0]
	if entry.Action != domain.AuditActionSettingsUpdate || entry.Entity != domain.AuditEntitySettings {
		t.Fatalf("audit = %q/%q, want settings.update/settings", entry.Action, entry.Entity)
	}
	if entry.Metadata["key"] != "settings.test-mail" {
		t.Fatalf("audit key = %q, want settings.test-mail", entry.Metadata["key"])
	}
}

// TestSettingsTestMail_RateLimited membuktikan batas 3/jam per user: tiga
// kirim pertama 200, kirim keempat 429 dengan amplop RATE_LIMITED.
func TestSettingsTestMail_RateLimited(t *testing.T) {
	mailer := &fakeProbeMailer{}
	h, _, _ := newProbeHandler(probeInt(26), 26, mailer)
	engine := gin.New()
	engine.Use(withActor(domain.RoleDevSuperAdmin, ""))
	engine.POST("/settings/test-mail", h.TestMail)

	for i := 0; i < 3; i++ {
		if rec := serveJSON(engine, "POST", "/settings/test-mail", "{}"); rec.Code != 200 {
			t.Fatalf("kirim %d: status = %d, want 200", i+1, rec.Code)
		}
	}
	rec := serveJSON(engine, "POST", "/settings/test-mail", "{}")
	if rec.Code != 429 {
		t.Fatalf("kirim 4: status = %d, want 429", rec.Code)
	}
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "RATE_LIMITED" {
		t.Fatalf("amplop 429 = %+v, want kode RATE_LIMITED", env.Error)
	}
	if len(mailer.calls) != 3 {
		t.Fatalf("mail terkirim = %d, want 3 (yang ke-4 tidak boleh antre)", len(mailer.calls))
	}
}

// TestSettingsTestMail_MailerDisabled503 membuktikan probe menjawab 503
// saat SMTP mati (mailer nil) alih-alih mengaku sukses.
func TestSettingsTestMail_MailerDisabled503(t *testing.T) {
	svc := settings.NewService(&fakeSettingsRepo{}).
		WithSystem(&fakeProbeVersions{v: probeInt(26)}, &fakeProbeStats{}, 26)
	h := handlers.NewSettingsHandler(svc).
		WithUsers(&fakeProbeUsers{email: "owner@thc.local"})
	engine := gin.New()
	engine.Use(withActor(domain.RoleDevSuperAdmin, ""))
	engine.POST("/settings/test-mail", h.TestMail)

	rec := serveJSON(engine, "POST", "/settings/test-mail", "{}")
	if rec.Code != 503 {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	env := decodeEnvelope(t, rec)
	if env.Success || env.Error == nil || env.Error.Code != "MAILER_DISABLED" {
		t.Fatalf("amplop 503 = %+v, want kode MAILER_DISABLED", env.Error)
	}
}
