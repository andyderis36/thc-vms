# E2E Provisioned Accounts — Teardown Terjamin (harness only)

Kontrak env: `E2E_API_BASE_URL` + kredensial superadmin (`E2E_EMAIL_SUPERADMIN`/`E2E_PASSWORD`).
Opt-in provisi: `E2E_LOCAL_PROVISION=1` (local, `:8080`) atau `E2E_LIVE_PROVISION=1` (live);
tanpa flag = kredensial seed, tanpa perubahan perilaku. Email harness `e2e-<runid>-<role>@domain`
cocok USER_MARKER `sweep.ts`; seed (`vendor1a@`, `admin1@`, …) tak berpola itu dan tak tersentuh.
Pre-suite: sweep `--apply` (live) lalu provisi + injeksi `E2E_RUN_ID`/`E2E_EMAIL_*`/`E2E_PASSWORD`.
Post-suite (finally, sukses/gagal/Ctrl+C): `sweep --apply` visits-first, lalu
`provision --teardown-only` (exact-email `DELETE /users/{id}` + `/users/security/{id}`,
204/404 toleran); exit code suite dipertahankan. Recovery: `node e2e/provision-live-users.ts
--teardown-only --run-id <id>` (ledger `$TEMP/e2e-provision-<runid>.json`) lalu
`node e2e/sweep.ts --apply`. Objek MinIO yang diunggah TIDAK ikut terhapus (orphan di bucket).
