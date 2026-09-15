# Chart of Accounts — Struktur Data

Konsep bisnisnya ada di `docs/domain/chart-of-accounts.md` — file ini fokus ke bagaimana datanya disimpan dan aturan apa yang dijaga otomatis oleh sistem. Kalau butuh detail teknis (kode SQL, nama fungsi persis), itu ada di `supabase/migrations/0002_coa_schema.sql`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `app_roles` | Daftar peran yang dikenal sistem: `master`, `admin`, `cashier` | — |
| `app_user_roles` | Peran yang dipegang tiap user (1 user boleh punya lebih dari 1 peran) | `app_roles`, user login |
| `app_user_signup_whitelist` | Daftar email yang boleh registrasi + 1 peran yang bakal didapat | `app_roles`, `auth.users` (lewat trigger, bukan FK langsung) |
| `accounts` | Daftar akun (Chart of Accounts itu sendiri) | Bisa nunjuk ke akun lain sebagai "induk" (struktur header/leaf) |

> **Migration:** `supabase/migrations/0002_coa_schema.sql` — representasi final, bukan histori incremental (lihat `git log` buat evolusi keputusan). Tabel config/infrastruktur cross-cutting (`app_roles`, `app_user_roles`, `app_user_signup_whitelist`) pakai prefix `app_` biar gampang dibedain dari tabel domain bisnis kalau template ini di-fork jadi project lain.

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `app_roles` | Daftar peran yang dikenal sistem (lihat submodule "Registrasi & Manajemen User") | — |
| `app_user_roles` | Peran yang dipegang tiap user (1 user boleh punya lebih dari 1 peran) | `app_roles`, user login |
| `accounts` | Daftar akun (Chart of Accounts itu sendiri) | Self-relasi ke `accounts` lain sebagai "induk" |

**Struktur `accounts` (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `code`, `name` | Kode & nama akun | Kode gak boleh dobel |
| `category` | asset / liability / equity / revenue / expense | 1 dari 5 kategori baku akuntansi |
| `normal_balance` | debit / kredit | **Dihitung otomatis** dari kategori, gak bisa diisi manual |
| `parent_id` | menunjuk ke akun lain (atau kosong) | Ini yang bikin akun bisa jadi "header" (kalau punya anak) atau "leaf" (kalau gak punya anak) |
| status aktif/arsip | ada tidaknya tanggal arsip | Akun yang udah pernah dipakai di jurnal cuma bisa diarsipkan (gak bisa dihapus permanen) — akun yang belum pernah dipakai sama sekali boleh dihapus permanen |
| `created_by` | Email pembuat baris (snapshot, bukan FK) | Nullable — `NULL` di baris lama atau insert di luar jalur aplikasi. Konvensi sama dipakai `items`/`counterparties`/`bom_headers`/`bom_lines`, lihat `items-schema.md` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tambah akun baru | `create_account(p_name, p_category, p_parent_id, p_is_contra)` (`security invoker` — tetap ditegakkan RLS `accounts_insert` yang sama, cuma ngebungkus logic generate kode) | `code` di-generate otomatis (lihat submodule "Onboarding — Bootstrap Konfigurasi Awal"), bukan input user lagi; insert baris baru; `normal_balance` otomatis terhitung dari `category` | RLS `accounts_insert` (role `admin`, dulu `admin`/`accountant` — `accountant` dipensiunkan 2026-09-13, lihat submodule "Registrasi & Manajemen User" — DIPERKETAT lagi lewat submodule "Onboarding": sekarang juga menolak kalau `app_settings` masih kosong, berlaku untuk insert langsung maupun lewat RPC ini, `complete_onboarding` sendiri gak kena karena `security definer`); trigger `accounts_no_retroactive_header` menolak kalau `parent_id` nunjuk akun yang sudah dipakai transaksi (bakal jadi header retroaktif); `create_account` menolak kalau kategori akun anak beda dari kategori akun induk |
| Ubah akun | — (update langsung) | Update kolom | RLS `accounts_update` (role `admin`); trigger `accounts_published_lock` menolak perubahan `code`/`category`/`normal_balance`/`parent_id`/`is_contra` begitu akun sudah dipakai di `journal_lines` — `name`/`archived_at` tetap bebas diubah |
| Posting transaksi ke akun (modul Journal Entry) | `create_journal_entry` | Insert `journal_lines` menunjuk `account_id` | Trigger `journal_lines_leaf_only` menolak posting ke akun yang masih punya child (header) |
| Hapus akun | Klik "Hapus" di halaman detail akun | Akun belum pernah dipakai di jurnal → dihapus permanen. Akun sudah pernah dipakai (atau masih punya akun anak) → diarsipkan, bukan dihapus | Fungsi `delete_account` — coba hapus permanen dulu, baru arsipkan kalau ternyata masih direferensikan di tempat lain |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Sisi normal gak bisa salah ketik / gak nyambung sama kategori | Kolom `normal_balance` generated dari `category` |
| Transaksi cuma boleh posting ke akun leaf | Trigger `journal_lines_leaf_only` (didefinisikan di modul Journal Entry, dipasang ke `journal_lines`) |
| Akun leaf yang sudah dipakai gak boleh diam-diam jadi header | Trigger `accounts_no_retroactive_header` |
| Field kritikal akun terkunci setelah dipakai transaksi | Trigger `accounts_published_lock` (`code`/`category`/`normal_balance`/`parent_id`/`is_contra`) |
| Akun gak bisa dihapus permanen kalau udah pernah dipakai | Fungsi `delete_account` — hapus permanen cuma berhasil kalau belum ada referensi apa pun di tempat lain, kalau ada otomatis diarsipkan lewat `archived_at` sebagai fallback |
| Peran dikelola lewat lookup table, bukan enum, biar nambah peran baru gak butuh migration `ALTER TYPE` (relevan buat template ini di-fork jadi project lain) | Tabel `app_roles` + `app_user_roles` (PK komposit `user_id, role_name`) |
| Cuma email yang di-whitelist yang boleh registrasi | Auth Hook `before_user_created_hook` (lihat submodule "Registrasi & Manajemen User") |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `accounts.parent_id` | self-relasi (banyak-ke-satu) | `accounts` |
| `app_user_roles` | banyak-ke-satu | `app_roles`, user login (`auth.users`) |
| `journal_lines.account_id` (modul Journal Entry) | banyak-ke-satu, wajib leaf | `accounts` |

## Akun Kontra (Contra Account)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `accounts.is_contra` | Flag boolean penanda akun kontra | `accounts` itu sendiri, bukan tabel baru |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tandai akun sebagai kontra | — (lihat modul Fixed Assets) | Formula generated `normal_balance` bercabang berdasar `is_contra` — kebalik dari default kategori kalau `true` | Trigger `accounts_published_lock` ikut mengunci `is_contra` begitu akun dipakai transaksi |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kategori akun kontra tetap ikut akun pasangan, cuma normal balance yang kebalik | Formula generated `normal_balance` bercabang berdasar `is_contra` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `accounts.is_contra` | flag pada baris yang sama, dipakai formula generated | `accounts.category` / `accounts.normal_balance` |

## Onboarding — Bootstrap Konfigurasi Awal

Konsep bisnisnya ada di `docs/domain/chart-of-accounts.md` submodule "Onboarding / Setup Awal". Bagian ini murni teknis: RPC baru, gak ada tabel baru — semua insert ke tabel spine yang sudah ada (`accounts`, `app_default_account_settings`, `document_number_types`, `app_settings`, `counterparties`).

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Generate kode akun baru | `create_account(p_name, p_category, p_parent_id default null, p_is_contra default false)` | Akun tanpa `parent_id`: kode = kode tertinggi yang sudah dipakai di kategori yang sama (tanpa parent) + 100 (fallback ke basis kategori — `1000`/`2000`/`3000`/`4000`/`5000` — kalau belum ada satu pun). Akun dengan `parent_id`: kode = kode tertinggi di antara akun anak lain dari induk yang sama + 10 (fallback ke kode induk + 10 kalau belum punya anak). Retry-on-conflict kalau kena `unique_violation` (pola sama `generate_item_unit_barcode`, lihat `items-schema.md`), maks 20 percobaan | `security invoker` — tunduk ke RLS `accounts_insert` (admin doang); menolak kalau kategori akun anak beda dari kategori akun induk; menolak total kalau `app_settings` masih kosong (setup awal belum selesai) — mencegah kode dasar template "dicuri" akun gak terkait sebelum setup jalan |
| **Langkah 1** — Terapkan template COA + Default Akun + Daftar Jenis Dokumen | `bootstrap_default_accounts()` — gak ada parameter sama sekali | (1) insert 31 akun template COA + akun anaknya kalau kode belum ada (`on conflict (code) do nothing` — idempotent; ini SATU-SATUNYA sumber isi `accounts`, tabel ini gak lagi di-seed migration; sengaja TIDAK termasuk akun Aset Tetap — modul itu sudah dicabut dari roadmap, dan 2 dari akunnya nama aset fisik spesifik 1 bisnis, bukan generik), (2) insert 29 `document_number_types` kalau `doc_type` belum ada (jaring pengaman — normalnya udah keisi dari seed migration `0007`), (3) insert 19 `app_default_account_settings` kalau `role_key` belum ada (resolve `account_id` dari akun template by `code`+`name`+`category`; kalau ada role_key yang gagal ke-resolve — RPC gagal total dengan pesan jelas, bukan diam-diam skip) | `security definer`; menolak kalau caller bukan `admin`; idempotent, gak ada guard "cuma sekali" (aman dipanggil ulang) |
| **Langkah 2** — Isi identitas usaha + pajak (setup awal) | `complete_onboarding(p_company_name, p_company_address, p_npwp, p_logo_url, p_ppn_active, p_ppn_rate)` | Reuse/insert counterparty "Pelanggan Umum" **plus** baris `counterparty_type_mapping` role `customer`-nya (tanpa ini transaksi OUTBOUND pertama gagal kena trigger role guard), lalu insert **1 baris** `app_settings` (satu-satunya langkah yang TIDAK idempotent — baris singleton) | `security definer`; menolak kalau caller bukan `admin`; menolak total kalau `accounts`/`app_default_account_settings` masih kosong (langkah 1 belum jalan); menolak total kalau `app_settings` sudah punya baris — mencegah setup awal dipanggil ulang menimpa konfigurasi yang sudah dipakai bertransaksi |

Kenapa 2 RPC terpisah (bukan 1 RPC gabungan kayak desain awal): UI `/setup` perlu nampilin hasil langkah 1 sebagai tabel nyata (peran akun → akun ter-resolve, mirip tampilan halaman Pengaturan > Default Akun) sebelum user masuk ke langkah 2 — user "melihat dulu, baru lanjut", bukan submit 1 form besar sekaligus.

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kode akun bukan keputusan user, sistem yang generate | `create_account` — parameter `code` gak ada sama sekali di signature |
| Setup awal cuma boleh sekali selama konfigurasi belum ada | Guard `exists (select 1 from app_settings)` di awal `complete_onboarding`; `bootstrap_default_accounts` sengaja idempotent (boleh dipanggil ulang) karena bukan langkah yang "menimpa" apa pun |
| Sistem gak boleh dipakai transaksi sebelum konfigurasi wajib lengkap | `complete_onboarding` menolak jalan kalau `bootstrap_default_accounts` belum pernah sukses (Core Invariant: no partial write, cuma sekarang dicek lintas-RPC bukan 1 transaksi tunggal); gating redirect ke halaman setup ada di app layer (`app_settings` kosong = belum setup), bukan di database; `create_account` ikut dikunci guard yang sama biar urutan "setup dulu, baru tambah akun manual" gak bisa dilewati |
| Role check gak boleh cuma app-level, harus RLS juga | RLS `accounts_insert` DIPERKETAT (bukan cuma `create_account`) — sekarang ikut menolak insert langsung ke `accounts` lewat PostgREST/supabase-js kalau `app_settings` masih kosong, gak cuma dijaga di level RPC. Kedua RPC setup gak kena guard ini karena `security definer` (bypass RLS) |
| Default Akun gak boleh nempel ke akun yang salah walau kode kebetulan sama | Tiap resolusi role_key di `bootstrap_default_accounts` match `(code, name, category)` sekaligus, bukan `code` doang — kalau kode template kebetulan sudah dipakai akun lain yang gak terkait, select-nya return 0 baris dan assertion 19-role_key di bawah menangkapnya sebagai kegagalan, bukan diam-diam salah pasang |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `bootstrap_default_accounts` | insert (idempotent, `on conflict do nothing`) | `accounts`, `document_number_types` |
| `bootstrap_default_accounts` | insert (idempotent by `role_key`), FK resolve by `accounts.(code, name, category)` | `app_default_account_settings` |
| `complete_onboarding` | insert (reuse by nama kalau sudah ada) lalu FK ke `app_settings.walk_in_customer_id` | `counterparties` |
| `complete_onboarding` | insert (1x, guarded) | `app_settings` |

## Registrasi & Manajemen User

Sebelum 2026-09-13, `/signup` bisa dipakai siapa saja tanpa validasi — akun baru gak otomatis dapat role apa pun (murni manual lewat migration/SQL), dan gak ada cara assign/ubah role user lain lewat aplikasi (dulu tercatat sebagai scope-debt `user-role-admin-assignment.md`, sekarang ditutup lewat submodule ini).

**Sempat dicoba pendekatan lain, lalu dibalikin** (masih di hari yang sama): sempat dicoba admin-invite (master bikin akun langsung lewat Supabase Admin API + email "set password", gak ada jalur self-register sama sekali). Dibalikin ke self-service `/signup` + whitelist karena admin-invite gantung ke SMTP yang belum tentu dikonfigurasi (`inviteUserByEmail` gagal kalau email delivery belum aktif) — self-service signUp() gak butuh itu kalau email confirmation dimatikan. Final state: `/signup` tetap ada, master cuma nentuin email+role mana yang boleh daftar duluan lewat whitelist.

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `app_roles` | 3 peran: `master`, `admin`, `cashier` | — |
| `app_user_signup_whitelist` | Email yang boleh registrasi + `role_name` (1 kolom, bukan join table lagi sejak 2026-09-14) + `created_by`/`created_at`/`consumed_at` | `app_roles` |
| `app_user_roles` | 1 baris = 1 role milik 1 user. Non-master WAJIB tepat 1 baris (kebijakan "1 akun 1 role") — cuma `master` yang boleh multi-baris | `app_roles`, `auth.users` |

**Peran (role)**

| Role | Cakupan | Cara didapat |
|---|---|---|
| `master` | Superuser — semua akses ERP + POS + kelola user/role. Gak dicek eksplisit di satu pun policy/RPC modul lain (lihat "Keputusan" di bawah) | **Cuma manual lewat database** — gak pernah lewat invite/UI |
| `admin` | Full access ERP (transaksi + konfigurasi) — serapan dari role `accountant` lama, yang dipensiunkan karena permission-nya udah selalu digabung bareng `admin` di hampir semua guard | Whitelist (`master` tentuin di halaman User Management), orangnya isi password sendiri di `/signup` |
| `cashier` | Checkout POS doang, lewat `create_pos_sale` (security definer) | Whitelist (`master` tentuin di halaman User Management), orangnya isi password sendiri di `/signup` |

Role `viewer` juga dipensiunkan bareng `accountant` (2026-09-13) — gak pernah dicek di satu pun RLS policy/RPC sejak awal, jadi makna praktisnya sama kayak gak punya role sama sekali.

**Keputusan — role juga jadi gate akses APLIKASI, bukan cuma permission:** sejak kebijakan "1 akun 1 role", role juga nentuin aplikasi mana yang boleh dipakai — `admin`/`master` -> ERP, `cashier`/`master` -> POS. Dicek di titik login KEDUA app (`apps/erp/src/lib/app-access.ts` `hasErpAccess`, `apps/pos/src/lib/app-access.ts` `hasPosAccess`) — akun yang gak lolos langsung di-`signOut()` lagi dengan pesan error, bukan cuma dibatasi actionnya doang. `master` sengaja TIDAK ditambahkan ke ~70 RLS policy/RPC guard yang sudah ada di file migration lain (semua checknya berbentuk "role user termasuk salah satu dari [...]", row-existence, bukan exact-match) — akun master cukup dikasih role `admin` DAN `cashier` sekaligus (manual lewat database), otomatis lolos semua guard existing (RLS maupun app-access gate) tanpa nyentuh satu pun file lain.

**Bug yang sempat kejadian (2026-09-13), sudah ditutup trigger `user_roles_master_implies_all`:** `hasErpAccess`/`hasPosAccess` EKSPLISIT memasukkan `'master'` ke daftar role yang diizinkan (bukan cuma `admin`/`cashier`) -- jadi akun yang CUMA punya baris `master` (lupa dipasangkan `admin`+`cashier`) tetap BISA login ke kedua aplikasi (login-nya sukses), tapi begitu masuk, hampir semua actual write action gagal karena ~70 RLS policy/RPC itu cuma cek `role_name = 'admin'`/`'cashier'` literal, gak pernah tau soal `'master'`. Konfusing karena login-nya kelihatan "berhasil" padahal permission-nya rusak. Ditutup lewat trigger `user_roles_master_implies_all` -- begitu baris `master` di-insert ke `app_user_roles`, `admin`+`cashier` otomatis nyusul buat `user_id` yang sama, jadi gak ada lagi jalan buat kelupaan pasangkan manual. **Kalau mau cabut status master dari 1 akun, hapus ketiga baris role-nya sekaligus** (bukan cuma baris `master`) -- baris `admin`+`cashier` yang otomatis nempel gak ke-cleanup otomatis kalau cuma baris `master`-nya yang dihapus, dan bakal balik melanggar kebijakan "1 akun 1 role".

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Cek email boleh signup | Auth Hook `before_user_created_hook(event jsonb)` | Nolak `auth.signUp()` (`{"error":{"http_code":403,...}}`) kalau email gak ada di `app_user_signup_whitelist` yang belum `consumed_at` | Jalan SEBELUM baris `auth.users` ada — cuma bisa nolak, gak bisa insert `app_user_roles` (FK bakal gagal) |
| Assign role setelah signup sukses | Trigger `handle_new_user_role_assignment` (`after insert on auth.users`) | Insert 1 baris `app_user_roles` dari `app_user_signup_whitelist.role_name`, tandai whitelist `consumed_at` | 1 transaksi sama dengan insert `auth.users` — gagal di sini = seluruh signup rollback |
| Lihat semua user + role-nya | RPC `list_app_users()` | Gabungin `auth.users`+`app_user_roles` (client gak bisa query `auth.users` langsung) | Role `master` |
| Ubah role user yang sudah ada | RPC `set_user_roles(p_user_id, p_roles)` | Ganti total set role `admin`/`cashier` milik 1 user | Role `master`; nolak kalau `p_roles` kosong, mengandung `'master'`, atau lebih dari 1 elemen (kebijakan 1 akun 1 role) |
| Tambah/hapus undangan whitelist | RPC `add_whitelist_entry(p_email, p_role)` / `remove_whitelist_entry(p_id)` | Insert/hapus 1 baris `app_user_signup_whitelist` | Role `master`; `remove_whitelist_entry` nolak kalau undangan udah dipakai signup — gak bisa dicabut lagi, cuma bisa dihapus manual lewat SQL kalau perlu re-invite email yang sama |
| Master otomatis dapat admin+cashier | Trigger `user_roles_master_implies_all` (`after insert on app_user_roles`) | Begitu baris `master` di-insert, `admin`+`cashier` otomatis nyusul buat `user_id` yang sama | Cuma nutup jalur INSERT (lihat catatan bug di atas) |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Cuma email yang diundang yang boleh punya akun | Auth Hook `before_user_created_hook` |
| Role `master` gak pernah bisa didapat lewat signup atau UI | `check (role_name <> 'master')` di `app_user_signup_whitelist`, guard eksplisit di `set_user_roles`/`add_whitelist_entry` |
| 1 akun = tepat 1 role (kecuali `master`) | Guard `array_length(p_roles,1) > 1` di `set_user_roles`; `app_user_signup_whitelist.role_name` cuma 1 kolom (`not null`), gak bisa >1 role per undangan secara struktural |
| Whitelist/User Management cuma bisa dikelola `master` | Guard eksplisit di `list_app_users`, `set_user_roles`, `add_whitelist_entry`, `remove_whitelist_entry` — `app_user_signup_whitelist` sendiri RLS default-deny buat insert/update/delete langsung |
| Master otomatis dapat admin+cashier, gak bisa lupa dipasangkan manual | Trigger `user_roles_master_implies_all` |

**Catatan penting:** submodule ini menutup celah "siapa boleh punya akun sama sekali" DAN "aplikasi mana yang boleh dia akses". Celah TERPISAH yang masih terbuka: ~50 RLS policy `SELECT` di seluruh schema cuma cek `auth.role()='authenticated'` (bukan role spesifik), jadi user role apa pun (termasuk `cashier`) tetap bisa baca semua data finansial lewat query langsung ke tabel — lihat `memory/scope-debt/rls-select-not-role-scoped.md`.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar akun (termasuk yang diarsipkan) | Semua user yang sudah login |
| Menambah/mengubah akun | Role `admin` (dulu `admin`/`accountant`) |
| Menghapus akun secara permanen | **Tidak ada seorang pun** — ini sengaja ditutup total di level sistem, sesuai aturan "arsip, bukan hapus" |
| Melihat peran diri sendiri | User yang bersangkutan (gak bisa lihat peran user lain lewat query langsung — lihat `list_app_users()` buat `master`) |
| Registrasi akun baru | Cuma email yang sudah di-whitelist oleh `master` |
| Kelola whitelist & role user lain | Role `master` doang |
