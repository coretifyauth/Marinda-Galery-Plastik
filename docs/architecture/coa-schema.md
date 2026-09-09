# Chart of Accounts — Struktur Data

Konsep bisnisnya ada di `docs/domain/chart-of-accounts.md` — file ini fokus ke bagaimana datanya disimpan dan aturan apa yang dijaga otomatis oleh sistem. Kalau butuh detail teknis (kode SQL, nama fungsi persis), itu ada di `supabase/migrations/0002_coa_schema.sql`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `roles` | Daftar peran yang dikenal sistem: `admin`, `accountant`, `viewer` | — |
| `user_roles` | Peran yang dipegang tiap user (1 user boleh punya lebih dari 1 peran) | `roles`, user login |
| `accounts` | Daftar akun (Chart of Accounts itu sendiri) | Bisa nunjuk ke akun lain sebagai "induk" (struktur header/leaf) |

> **Migration final (2026-09-07):** `supabase/migrations/0002_coa_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `roles` | Daftar peran yang dikenal sistem | — |
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

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tambah akun baru | — (insert langsung ke `accounts`, bukan financial write jadi gak lewat RPC) | Insert baris baru; `normal_balance` otomatis terhitung dari `category` | RLS `accounts_insert` (admin/accountant); trigger `accounts_no_retroactive_header` menolak kalau `parent_id` nunjuk akun yang sudah dipakai transaksi (bakal jadi header retroaktif) |
| Ubah akun | — (update langsung) | Update kolom | RLS `accounts_update` (admin/accountant); trigger `accounts_published_lock` menolak perubahan `code`/`category`/`normal_balance`/`parent_id`/`is_contra` begitu akun sudah dipakai di `journal_lines` — `name`/`archived_at` tetap bebas diubah |
| Posting transaksi ke akun (modul Journal Entry) | `create_journal_entry` | Insert `journal_lines` menunjuk `account_id` | Trigger `journal_lines_leaf_only` menolak posting ke akun yang masih punya child (header) |
| Hapus akun | Klik "Hapus" di halaman detail akun | Akun belum pernah dipakai di jurnal → dihapus permanen. Akun sudah pernah dipakai (atau masih punya akun anak) → diarsipkan, bukan dihapus | Fungsi `delete_account` — coba hapus permanen dulu, baru arsipkan kalau ternyata masih direferensikan di tempat lain |
| Assign peran ke user lain | — (belum ada, masih manual/migration) | — | Butuh fungsi `security definer` biar gak circular-check ke `user_roles` sendiri — belum digarap, ditunda sampai ada layar user management |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Sisi normal gak bisa salah ketik / gak nyambung sama kategori | Kolom `normal_balance` generated dari `category` |
| Transaksi cuma boleh posting ke akun leaf | Trigger `journal_lines_leaf_only` (didefinisikan di modul Journal Entry, dipasang ke `journal_lines`) |
| Akun leaf yang sudah dipakai gak boleh diam-diam jadi header | Trigger `accounts_no_retroactive_header` |
| Field kritikal akun terkunci setelah dipakai transaksi | Trigger `accounts_published_lock` (`code`/`category`/`normal_balance`/`parent_id`/`is_contra`) |
| Akun gak bisa dihapus permanen kalau udah pernah dipakai | Fungsi `delete_account` — hapus permanen cuma berhasil kalau belum ada referensi apa pun di tempat lain, kalau ada otomatis diarsipkan lewat `archived_at` sebagai fallback |
| Peran dikelola lewat lookup table, bukan enum, biar nambah peran baru gak butuh migration `ALTER TYPE` | Tabel `roles` + `user_roles` (PK komposit `user_id, role_name`) |

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

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar akun (termasuk yang diarsipkan) | Semua user yang sudah login |
| Menambah/mengubah akun | Role `admin` atau `accountant` |
| Menghapus akun secara permanen | **Tidak ada seorang pun** — ini sengaja ditutup total di level sistem, sesuai aturan "arsip, bukan hapus" |
| Melihat peran diri sendiri | User yang bersangkutan (gak bisa lihat peran user lain) |
