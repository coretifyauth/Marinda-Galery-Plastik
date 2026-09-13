# Chart of Accounts — Struktur Data

Konsep bisnisnya ada di `docs/domain/chart-of-accounts.md` — file ini fokus ke bagaimana datanya disimpan dan aturan apa yang dijaga otomatis oleh sistem. Kalau butuh detail teknis (kode SQL, nama fungsi persis), itu ada di `supabase/migrations/0002_coa_schema.sql`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `roles` | Daftar peran yang dikenal sistem: `master`, `admin`, `cashier` | — |
| `user_roles` | Peran yang dipegang tiap user (1 user boleh punya lebih dari 1 peran) | `roles`, user login |
| `signup_whitelist` / `signup_whitelist_roles` | Daftar email yang boleh registrasi + peran yang bakal didapat | `roles`, `auth.users` (lewat trigger, bukan FK langsung) |
| `accounts` | Daftar akun (Chart of Accounts itu sendiri) | Bisa nunjuk ke akun lain sebagai "induk" (struktur header/leaf) |

> **Migration final (2026-09-07):** `supabase/migrations/0002_coa_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `roles` | Daftar peran yang dikenal sistem (lihat submodule "Registrasi & Manajemen User") | — |
| `user_roles` | Peran yang dipegang tiap user (1 user boleh punya lebih dari 1 peran) | `roles`, user login |
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
| Tambah akun baru | — (insert langsung ke `accounts`, bukan financial write jadi gak lewat RPC) | Insert baris baru; `normal_balance` otomatis terhitung dari `category` | RLS `accounts_insert` (role `admin`, dulu `admin`/`accountant` — `accountant` dipensiunkan 2026-09-13, lihat submodule "Registrasi & Manajemen User"); trigger `accounts_no_retroactive_header` menolak kalau `parent_id` nunjuk akun yang sudah dipakai transaksi (bakal jadi header retroaktif) |
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
| Peran dikelola lewat lookup table, bukan enum, biar nambah peran baru gak butuh migration `ALTER TYPE` | Tabel `roles` + `user_roles` (PK komposit `user_id, role_name`) |
| Cuma email yang di-whitelist yang boleh registrasi | Auth Hook `before_user_created_hook` (lihat submodule "Registrasi & Manajemen User") |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `accounts.parent_id` | self-relasi (banyak-ke-satu) | `accounts` |
| `user_roles` | banyak-ke-satu | `roles`, user login (`auth.users`) |
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

## Registrasi & Manajemen User

Sebelum 2026-09-13, `/signup` bisa dipakai siapa saja tanpa validasi — akun baru gak otomatis dapat role apa pun (murni manual lewat migration/SQL), dan gak ada cara assign/ubah role user lain lewat aplikasi (dulu tercatat sebagai scope-debt `user-role-admin-assignment.md`, sekarang ditutup lewat submodule ini).

**Sempat dicoba pendekatan lain, lalu dibalikin** (masih di hari yang sama): sempat dicoba admin-invite (master bikin akun langsung lewat Supabase Admin API + email "set password", gak ada jalur self-register sama sekali). Dibalikin ke self-service `/signup` + whitelist karena admin-invite gantung ke SMTP yang belum tentu dikonfigurasi (`inviteUserByEmail` gagal kalau email delivery belum aktif) — self-service signUp() gak butuh itu kalau email confirmation dimatikan. Final state: `/signup` tetap ada, master cuma nentuin email+role mana yang boleh daftar duluan lewat whitelist.

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `roles` | 3 peran: `master`, `admin`, `cashier` | — |
| `signup_whitelist` | Email yang boleh registrasi + `created_by`/`created_at`/`consumed_at` | — |
| `signup_whitelist_roles` | Peran yang bakal didapat 1 entry whitelist begitu dipakai signup | `signup_whitelist`, `roles` |
| `user_roles` | 1 baris = 1 role milik 1 user. Non-master WAJIB tepat 1 baris (kebijakan "1 akun 1 role") — cuma `master` yang boleh multi-baris | `roles`, `auth.users` |

**Peran (role)**

| Role | Cakupan | Cara didapat |
|---|---|---|
| `master` | Superuser — semua akses ERP + POS + kelola user/role. Gak dicek eksplisit di satu pun policy/RPC modul lain (lihat "Keputusan" di bawah) | **Cuma manual lewat database** — gak pernah lewat invite/UI |
| `admin` | Full access ERP (transaksi + konfigurasi) — serapan dari role `accountant` lama, yang dipensiunkan karena permission-nya udah selalu digabung bareng `admin` di hampir semua guard | Whitelist (`master` tentuin di halaman User Management), orangnya isi password sendiri di `/signup` |
| `cashier` | Checkout POS doang, lewat `create_pos_sale` (security definer) | Whitelist (`master` tentuin di halaman User Management), orangnya isi password sendiri di `/signup` |

Role `viewer` juga dipensiunkan bareng `accountant` (2026-09-13) — gak pernah dicek di satu pun RLS policy/RPC sejak awal, jadi makna praktisnya sama kayak gak punya role sama sekali.

**Keputusan — role juga jadi gate akses APLIKASI, bukan cuma permission:** sejak kebijakan "1 akun 1 role", role juga nentuin aplikasi mana yang boleh dipakai — `admin`/`master` -> ERP, `cashier`/`master` -> POS. Dicek di titik login KEDUA app (`apps/erp/src/lib/app-access.ts` `hasErpAccess`, `apps/pos/src/lib/app-access.ts` `hasPosAccess`) — akun yang gak lolos langsung di-`signOut()` lagi dengan pesan error, bukan cuma dibatasi actionnya doang. `master` sengaja TIDAK ditambahkan ke ~70 RLS policy/RPC guard yang sudah ada di file migration lain (semua checknya berbentuk "role user termasuk salah satu dari [...]", row-existence, bukan exact-match) — akun master cukup dikasih role `admin` DAN `cashier` sekaligus (manual lewat database), otomatis lolos semua guard existing (RLS maupun app-access gate) tanpa nyentuh satu pun file lain.

**Bug yang sempat kejadian (2026-09-13), sudah ditutup trigger `user_roles_master_implies_all`:** `hasErpAccess`/`hasPosAccess` EKSPLISIT memasukkan `'master'` ke daftar role yang diizinkan (bukan cuma `admin`/`cashier`) -- jadi akun yang CUMA punya baris `master` (lupa dipasangkan `admin`+`cashier`) tetap BISA login ke kedua aplikasi (login-nya sukses), tapi begitu masuk, hampir semua actual write action gagal karena ~70 RLS policy/RPC itu cuma cek `role_name = 'admin'`/`'cashier'` literal, gak pernah tau soal `'master'`. Konfusing karena login-nya kelihatan "berhasil" padahal permission-nya rusak. Ditutup lewat trigger `user_roles_master_implies_all` -- begitu baris `master` di-insert ke `user_roles`, `admin`+`cashier` otomatis nyusul buat `user_id` yang sama, jadi gak ada lagi jalan buat kelupaan pasangkan manual. **Kalau mau cabut status master dari 1 akun, hapus ketiga baris role-nya sekaligus** (bukan cuma baris `master`) -- baris `admin`+`cashier` yang otomatis nempel gak ke-cleanup otomatis kalau cuma baris `master`-nya yang dihapus, dan bakal balik melanggar kebijakan "1 akun 1 role".

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Cek email boleh signup | Auth Hook `before_user_created_hook(event jsonb)` | Nolak `auth.signUp()` (`{"error":{"http_code":403,...}}`) kalau email gak ada di `signup_whitelist` yang belum `consumed_at` | Jalan SEBELUM baris `auth.users` ada — cuma bisa nolak, gak bisa insert `user_roles` (FK bakal gagal) |
| Assign role setelah signup sukses | Trigger `handle_new_user_role_assignment` (`after insert on auth.users`) | Insert baris `user_roles` sesuai `signup_whitelist_roles`, tandai whitelist `consumed_at` | 1 transaksi sama dengan insert `auth.users` — gagal di sini = seluruh signup rollback |
| Lihat semua user + role-nya | RPC `list_app_users()` | Gabungin `auth.users`+`user_roles` (client gak bisa query `auth.users` langsung) | Role `master` |
| Ubah role user yang sudah ada | RPC `set_user_roles(p_user_id, p_roles)` | Ganti total set role `admin`/`cashier` milik 1 user | Role `master`; nolak kalau `p_roles` kosong, mengandung `'master'`, atau lebih dari 1 elemen (kebijakan 1 akun 1 role) |
| Tambah/hapus undangan whitelist | RPC `add_whitelist_entry(p_email, p_roles)` / `remove_whitelist_entry(p_id)` | Insert/hapus baris `signup_whitelist`+`signup_whitelist_roles` | Role `master`; `remove_whitelist_entry` nolak kalau undangan udah dipakai signup — gak bisa dicabut lagi, cuma bisa dihapus manual lewat SQL kalau perlu re-invite email yang sama |
| Master otomatis dapat admin+cashier | Trigger `user_roles_master_implies_all` (`after insert on user_roles`) | Begitu baris `master` di-insert, `admin`+`cashier` otomatis nyusul buat `user_id` yang sama | Cuma nutup jalur INSERT (lihat catatan bug di atas) |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Cuma email yang diundang yang boleh punya akun | Auth Hook `before_user_created_hook` |
| Role `master` gak pernah bisa didapat lewat signup atau UI | `check (role_name <> 'master')` di `signup_whitelist_roles`, guard eksplisit di `set_user_roles`/`add_whitelist_entry` |
| 1 akun = tepat 1 role (kecuali `master`) | Guard `array_length(p_roles,1) > 1` di `set_user_roles`/`add_whitelist_entry` |
| Whitelist/User Management cuma bisa dikelola `master` | Guard eksplisit di `list_app_users`, `set_user_roles`, `add_whitelist_entry`, `remove_whitelist_entry` — `signup_whitelist`/`signup_whitelist_roles` sendiri RLS default-deny buat insert/update/delete langsung |
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
