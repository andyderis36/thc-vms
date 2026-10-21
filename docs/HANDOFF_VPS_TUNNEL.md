HANDOFF CONTEXT
===============

USER REQUESTS (AS-IS)
---------------------
- "intinya gw mau ketika akses "http://10.11.6.110/" kamera bisa diakses dari browser biasa atau incognito mode! dari hp tablet juga bisa!"
- "live prod masih belum bisa akses kamera. emang gabisa ya diakalin biar di live prod bisa akses kamera tanpa harus HTTPS? #ask"
- "okelah bro kalo begitu buatkan handoff untuk agent di vps supaya buat tunnel project dari vps"
- "bro lakukan testing ringan di deployment vps "10.11.6.110""

(Sesi aslinya dimulai dengan handoff sebelumnya; repo AGENTS.md + docs/ adalah SSOT dan tidak kucetak ulang di sini.)

GOAL
----
Pasang Cloudflare Tunnel di VPS (10.11.6.110) yang menyajikan aplikasi THC-VMS pada hostname HTTPS stabil, sehingga kamera di halaman /gate berfungsi pada browser biasa, mode incognito, dan HP/tablet — tanpa perubahan kode aplikasi.

WORK COMPLETED
--------------
- Saya sudah membuktikan akar masalahnya: `getUserMedia` hanya ada pada secure context. Di origin `http://10.11.6.110` browser tidak pernah mengekspos `navigator.mediaDevices` sama sekali, jadi kamera mustahil dipakai — bukan soal izin. Flag Chrome `--unsafely-treat-insecure-origin-as-secure` membuktikannya (di origin yang sama: isSecureContext false -> true, mediaDevices undefined -> ada), tetapi switch itu hanya berlaku untuk Chrome/Edge desktop dan per-proses, TIDAK untuk iOS Safari dan tidak untuk tab/incognito dari browser yang sudah jalan. Karena itu permintaan "browser biasa + incognito + HP/tablet" hanya bisa dijawab dengan HTTPS asli.
- Frontend sudah same-origin: `frontend/src/lib/api/fetcher.ts` `resolveApiBase()` mengembalikan PATH dari `NEXT_PUBLIC_API_BASE_URL` untuk host non-localhost, jadi FE memanggil `<origin-sekarang>/api/v1`. Artinya Tunnel tidak butuh rebuild FE maupun perubahan NEXT_PUBLIC_API_BASE_URL.
- `caddy/Caddyfile` sudah dirancang satu-origin: `handle /api/*` -> backend:8080, `handle_path /s3/*` -> minio:9000, sisanya -> frontend:3210, dengan host dari env `SITE_ADDRESS` (kosong = catch-all ":80").
- Saya sudah kerjakan & deploy perbaikan produksi lain (sudah live, tidak perlu disentuh lagi): PATCH /users/{id} tadinya balas 200 tanpa menyimpan (handler tak terpasang di DI) — kini persist + ada boot guard; POST /visits tadinya 422 "http hanya diizinkan untuk localhost" — kini 201; pesan scanner kini membedakan konteks non-secure dari penolakan izin; "Lihat detail" untuk /users, /facilities, /security; F3/F5/H5/H1; pindah cabang satpam.
- Dokumentasi kios HTTP + launcher sudah ada: `docs/7. DEPLOY_VPS.md` §9, `vms-kiosk.ps1`/`.cmd` (Chrome + switch, profil terpisah), `vms-git-auth.ps1`/`.cmd`.

CURRENT STATE
-------------
- Repo: D:\otak-atik\THC\thc-vms. Branch `dev` = df0239c (sinkron origin/dev), `main` = 4a60853 (sinkron origin/main). Working tree CLEAN. Model branch baru: `dev` = branch kerja, `main` = pointer deploy; `main` hanya maju lewat merge --no-ff dari `dev` (AGENTS.md §1.1).
- Produksi: 10.11.6.110, docker compose prod. Service: postgres, minio, migrate (one-shot), backend (publish 8080), frontend (internal 3210), caddy (publish 80 + 443). Deploy dipicu push ke `main` lewat .gitea/workflows/deploy.yml (runner self-hosted di VPS), deploy.sh melakukan `git fetch origin` + `git reset --hard origin/main` lalu compose up.
- `SITE_ADDRESS` di .env VPS saat ini kosong (Caddy catch-all ":80"), itu sebabnya hanya http:// yang tersedia.
- `S3_PUBLIC_BASE_URL` dipakai backend untuk membangun URL file yang dikembalikan ke FE (contoh respons upload produksi: `http://10.11.6.110/s3/thc-vms-bucket/id_cards/pending-<user>/ktp.jpg`).
- Verifikasi baseline produksi sebelum agent mulai: GET http://10.11.6.110/api/v1/health -> 200 healthy; GET /api/v1/users -> 200 (26 user); GET /users/security -> 200 (10); GET /locations -> 200 (5).
- thckalbar.com (58.147.187.14) adalah server lain (Traefik default cert), BUKAN app THC. Jangan dipakai sebagai hostname.
- Gate repo terakhir: go build 0, 718 Go test, tsc 0, eslint 0, vitest 580+ (semua hijau), next build sukses.

PENDING TASKS
-------------
- Utama: buat Cloudflare Tunnel NAMED (hostname stabil) di VPS -> ingress ke http://localhost:80 (Caddy). Issu tunnel lewat dashboard Cloudflare (Zero Trust) atau API dengan token scope Cloudflare Tunnel:Edit; salin credentials.json ke VPS (chmod 600, JANGAN pernah di-commit).
- Setelah tunnel hidup, set di .env VPS: `S3_PUBLIC_BASE_URL=https://<host-tunnel>/s3/thc-vms-bucket` (wajib, kalau tidak halaman HTTPS akan kena mixed content dan file KTP/selfie/SPK tak tampil) dan `CORS_ALLOWED_ORIGINS` tambah `https://<host-tunnel>` (opsional, FE same-origin). JANGAN isi `SITE_ADDRESS` dengan hostname tunnel: itu membuat Caddy mencoba ACME dan bentrok dengan TLS di edge Cloudflare. Biarkan `SITE_ADDRESS` kosong; TLS selesai di edge, Caddy melayani HTTP ke tunnel.
- `NEXT_PUBLIC_API_BASE_URL`/`:STORAGE_BASE_URL` TIDAK perlu diubah dan TIDAK perlu rebuild FE.
- Buat tunnel permanen (systemd unit host-level dengan cloudflared terinstall, atau service compose terpisah) supaya tetap hidup setelah reboot dan tidak ketergantungan terminal.
- Verifikasi akhir: curl https://<host>/api/v1/health -> 200; POST /uploads mengembalikan file_url berawalan https://<host>/s3/...; buka https://<host>/gate di browser -> window.isSecureContext === true -> prompt izin kamera muncul -> Allow -> kamera hidup.
- Opsional setelah itu: perbarui docs/7 §9 (tunjuk hostname tunnel sebagai jalur produksi) dan catat hostname tunnel di AGENTS.md §1.1 bila jadi rujukan.
- Todo list sesi ini: 6/7 selesai; sisa satu item rotasi token Gitea (butuh sesi web pemilik akun, di luar scope agent VPS).
- Blocker yang sudah kucek: tidak ada. Catatan: 10.11.6.110 adalah IP privat (RFC1918) jadi ACME HTTP-01 dari CA publik tidak akan bisa divalidasi — itu sebabnya Cloudflare Tunnel (atau DNS-01) adalah jalurnya, bukan certificate issuance biasa.

KEY FILES
---------
- caddy/Caddyfile - reverse proxy satu-origin: /api/* -> backend:8080, /s3/* -> minio:9000, else -> frontend:3210; host dari SITE_ADDRESS (kosong = ":80")
- docker-compose.prod.yml - topologi stack prod; caddy publish 80/443, backend publish 8080, minio tanpa publish (hanya lewat Caddy /s3)
- deploy/deploy.sh - alur deploy VPS: git reset --hard origin/main, compose up, guard .env, prune
- .env.prod.example - template env VPS: SITE_ADDRESS, S3_PUBLIC_BASE_URL, CORS_ALLOWED_ORIGINS, NEXT_PUBLIC_*, BOOTSTRAP_SEED, MINIO_IMAGE
- frontend/src/lib/api/fetcher.ts - resolveApiBase(): host non-localhost memakai PATH dari NEXT_PUBLIC_API_BASE_URL (same-origin, tak perlu rebuild FE)
- frontend/src/features/gate/ScannerPanel.tsx - pemanggil kamera; pesan error kinibedakan konteks non-secure vs izin ditolak
- frontend/src/features/gate/camera-support.ts - klasifikasi kegagalan kamera (murni, unit-tested)
- docs/7. DEPLOY_VPS.md - runbook deploy; §9 menjelaskan kamera kios pada origin HTTP
- vms-tunnel.ps1 - tunnel Cloudflare QUICK untuk demo lokal (random hostname) — JANGAN dipakai untuk produksi; hostname harus stabil
- AGENTS.md - supreme directive: §1.1 alur branch (dev kerja, main deploy), §8 aturan deploy (satu trigger saja, .env tak pernah di-commit)

IMPORTANT DECISIONS
-------------------
- HTTPS (bukan flag Chrome) yang dipilih untuk\App, karena flag hanya berlaku Chrome/Edge desktop per-proses, tidak menutup iOS Safari, dan tidak berlaku untuk tab/incognito dari browser yang sudah jalan.
- Tunnel diarahkan ke Caddy :80, bukan langsung ke frontend:3210, supaya app + /api/v1 + /s3 tetap satu origin dan tidak ada mixed content.
- Tunnel harus NAMED (hostname stabil), bukan quick tunnel, karena S3_PUBLIC_BASE_URL dan CORS_ALLOWED_ORIGINS ikut memuat hostname itu; quick tunnel mengubah hostname tiap restart sehingga keduanya harus diubah ulang.
- SITE_ADDRESS sengaja dibiarkan kosong di belakang tunnel: TLS diurus Cloudflare, Caddy cukup layani HTTP untuk origin request dari tunnel.
- FE tidak diubah sama sekali: resolveApiBase() sudah same-origin, jadi tunnel otomatis dipakai begitu host-nya HTTPS.
- Pola frontend: primitive generik (components/ui/DetailModal.tsx) dipakai lintas halaman, bukan modal per halaman.
- Dokumen memakai bahasa Indonesia; file .ps1 wajib ASCII murni tanpa BOM karena Windows PowerShell 5.1 membaca file tanpa BOM sebagai ANSI dan merusak string yang memuat karakter non-ASCII.

EXPLICIT CONSTRAINTS
--------------------
- "jangan commit/push tanpa perintah!!!"
- "KERJAKAN DENGAN TELITI, HATI-HATI, TEPAT, PROFESIONAL!!!"
- "CLEAN CODE, CLEAN ARCHITECTURE!!!"
- "PRINSIP SOLID, DRY, KISS, YAGNI!!!"
- "kerjakan dengan sub-agent jika memungkinkan untuk menghemat token!!!"
- Aturan emas AGENTS.md: DILARANG keras git commit atau git push tanpa perintah eksplisit user; branch `dev` = branch kerja default dan `main` = branch produksi (naik hanya lewat merge --no-ff dari dev, lalu push atas perintah user); JANGAN pernah commit .env nyata; jangan menambah trigger deploy kedua (webhook dilarang); satu-satunya trigger deploy adalah .gitea/workflows/deploy.yml; seed ke production dilarang kecuali bootstrap DB kosong yang diaktifkan operator lewat BOOTSTRAP_SEED=1; bucket storage tetap privat; migrasi forward-only dan tidak di-rollback.
- Runtime (docker, BE, FE, DB) milik user: jangan start/stop/kill tanpa perintah; lanjutkan pekerjaan lewat .env + deploy yang sudah ada.

CONTEXT FOR CONTINUATION
------------------------
- Semua perbaikan produksi di sesi ini sudah ter-deploy dan terverifikasi di 10.11.6.110 (create visit 201, update user persist, UI "Lihat detail" live). Agent VPS tidak perlu menyentuh kode aplikasi untuk task tunnel ini.
- Repo punya `vms.ps1`/`vms.cmd` (stack lokal Windows) dan `vms-tunnel.ps1` (tunnel quick untuk demo lokal). Keduanya untuk mesin dev, bukan untuk VPS; jangan disalin mentah ke VPS.
- Dokumentasi resmi deploy: docs/7. DEPLOY_VPS.md, docs/DEPLOY_PROD.md, docs/5. LOCAL_DEV.md, dan docs/4. openapi.yaml sebagai kontrak API.
- Kalau hostname tunnel dipakai sebagai rujukan produksi, perbarui CORS_ALLOWED_ORIGINS + S3_PUBLIC_BASE_URL di .env VPS lalu re-deploy (deploy.sh membaca .env repo-root dan me-recreate container bila env berubah).
- Jangan pernah mengembalikan perubahan .env ke git; .env sudah di-ignore.
