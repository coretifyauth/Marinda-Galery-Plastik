# General Ledger & Journal Entry — Struktur Data

Konsep bisnisnya ada di `docs/domain/general-ledger.md` — file ini fokus ke struktur data & aturan otomatis. Detail teknis: `supabase/migrations/0003_journal_entry_schema.sql`. Akun yang dipakai bergantung ke `docs/architecture/coa-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `journal_entries` | Header 1 transaksi (tanggal, keterangan, dokumen sumber) | Bisa menunjuk ke entry lain yang dibalikkannya (reversing entry) |
| `journal_lines` | Baris debit/kredit dalam 1 transaksi | Setiap baris menunjuk ke 1 akun di Chart of Accounts |

> **Migration final (2026-09-07):** `supabase/migrations/0003_journal_entry_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `journal_entries` | Header 1 transaksi | Bisa menunjuk ke entry lain yang dibalikkannya |
| `journal_lines` | Baris debit/kredit | Menunjuk ke 1 akun di Chart of Accounts |

**Struktur `journal_entries`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `entry_date` | Tanggal transaksi | |
| `description` | Keterangan | |
| `source_ref` | Referensi ke dokumen sumber (nota, invoice, dst) | **Wajib diisi** — setiap transaksi harus bisa ditelusuri ke buktinya |
| menunjuk ke entry lain | Kalau entry ini adalah pembalik dari entry lain | Diisi otomatis oleh sistem saat proses "batalkan/reverse", bukan manual |

**Struktur `journal_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| akun tujuan | Akun mana yang kena | Wajib akun "leaf" (paling bawah), gak boleh akun header |
| debit | Nilai di sisi debit | |
| kredit | Nilai di sisi kredit | Cuma satu dari debit/kredit yang boleh keisi per baris, gak boleh dua-duanya sekaligus |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat transaksi baru | `create_journal_entry` | Header + semua baris debit/kredit disimpan bersamaan dalam 1 transaksi database — gagal sebagian = batal semua | Balance-check & leaf-only divalidasi sebelum benar-benar tersimpan |
| Balikkan transaksi | `reverse_journal_entry` | Membaca transaksi asli, membuat transaksi baru dengan debit/kredit ditukar, menautkannya balik ke transaksi asli | Satu-satunya jalur "koreksi" yang tersedia — gak ada jalur edit transaksi lama |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Setiap transaksi harus balance (total debit = total kredit) | Trigger balance-check, dijalankan pas transaksi mau selesai tersimpan (bukan per baris) |
| Minimal 2 baris per transaksi | Trigger yang sama di atas |
| Hanya akun leaf yang boleh diposting | Trigger leaf-only, jalan tiap baris baru masuk |
| Transaksi yang sudah tercatat tidak bisa diedit/dihapus | Dua lapis: ditolak di level akses data, ditolak lagi di level pemrosesan data — jadi meski satu lapis gagal dikonfigurasi, lapis kedua tetap menahan |
| Header dan semua barisnya masuk bersamaan, atau tidak sama sekali | Satu RPC atomik (`create_journal_entry`) — tidak ada jalur insert header dan baris secara terpisah |
| Akun yang sudah pernah dipakai transaksi terkunci sebagian field-nya | Trigger di tabel akun (dampak modul ini ke `coa-schema.md`) |
| Akun leaf yang sudah pernah diposting tidak bisa diam-diam berubah jadi header lewat penambahan akun anak baru | Trigger lain di tabel akun — mencegah pelanggaran aturan "leaf-only posting" secara retroaktif terhadap histori yang sudah ada |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `journal_lines` | banyak-ke-satu | `journal_entries` |
| `journal_lines` | banyak-ke-satu | Chart of Accounts (akun leaf) |
| `journal_entries` | opsional, satu-ke-satu (self-reference) | `journal_entries` lain (entry yang dibalikkannya) |
| Semua modul lain (AR, AP, Inventory, Fixed Assets) | wajib lewat | `create_journal_entry`/`reverse_journal_entry` — tidak ada jalur pencatatan keuangan di luar RPC ini |

## Preset Jurnal

Konsep bisnisnya: `docs/domain/general-ledger.md` submodule "Preset Jurnal". Detail teknis: `supabase/migrations/0032_preset_journal_entries_schema.sql`.

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `app_preset_journal_entries` | Header 1 preset (label, status draft/active/inactive) | — |
| `app_preset_journal_entry_lines` | Baris preset — akun + sisi (debit/kredit) terkunci, TANPA amount | `app_preset_journal_entries`, akun leaf di `accounts` |

**Struktur `app_preset_journal_entries`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `label` | Nama preset, mis. "Bayar Listrik" | |
| `status` | `draft` / `active` / `inactive` | default `draft`, state machine — lihat "Alur Teknis" |
| `activated_at` | Kapan draft→active terjadi | nullable, keisi sekali, gak pernah diubah lagi |

**Struktur `app_preset_journal_entry_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `account_id` | Akun tujuan baris ini | wajib leaf (reuse guard `journal_lines_leaf_only`) |
| `side` | `debit` / `credit` | akun+sisi ini yang terkunci begitu preset aktif — amount TETAP kosong di sini, diisi user tiap posting |
| `label` | Keterangan baris opsional | mis. "Beban Iklan Dept A" |
| `sort_order` | Urutan tampil | unique per preset |

**Alur Teknis (RPC)**

| Aksi | RPC/Cara | Efek | Guard |
|---|---|---|---|
| Kelola baris preset (draft) | INSERT/UPDATE/DELETE langsung ke `app_preset_journal_entry_lines` (bukan RPC — RLS+trigger cukup) | Tambah/ubah/hapus baris | Trigger `app_preset_journal_entry_lines_draft_only` — cuma jalan kalau header masih `draft`; trigger `journal_lines_leaf_only` — akun wajib leaf |
| Aktifkan preset | UPDATE `status='active'` langsung | Baris terkunci permanen, `activated_at` terisi | Trigger `app_preset_journal_entries_status_guard` — minimal 2 baris, minimal 1 debit & 1 kredit; transisi `draft→active` cuma sekali |
| Toggle nonaktif/aktifkan lagi | UPDATE `status` `active`↔`inactive` | Preset hilang/muncul lagi dari dropdown posting | Trigger yang sama — transisi `active↔inactive` bebas bolak-balik, tapi gak pernah balik ke `draft` |
| Hapus preset | DELETE langsung | Hapus permanen | Trigger `app_preset_journal_entries_delete_guard` — cuma boleh kalau status masih `draft` |
| Posting entry pakai preset | `create_journal_entry_from_preset` | Validasi preset `active` + jumlah baris input cocok jumlah baris preset, susun `p_lines` dari akun/sisi preset + jumlah dari user, lalu manggil `create_journal_entry` (reuse, 0003) | Preset harus `active`; tiap `line_id` harus bagian dari preset yang sama; jumlah wajib > 0; balance check tetap jalan di `create_journal_entry` seperti biasa |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Cuma role `master` yang boleh kelola preset (bikin/edit/aktifkan/nonaktifkan/hapus) | RLS insert/update/delete di kedua tabel — cek `app_user_roles.role_name = 'master'` |
| Baris preset cuma bisa diubah selagi `draft` | Trigger `app_preset_journal_entry_lines_draft_only` — berlaku juga kalau update/delete langsung lewat client, bukan cuma lewat RPC |
| Preset gak pernah balik ke `draft` dari `active`/`inactive` | Trigger `app_preset_journal_entries_status_guard` — transisi ilegal ditolak eksplisit |
| Aktivasi butuh minimal 2 baris + minimal 1 debit & 1 kredit | Trigger yang sama, dicek pas transisi `draft→active` |
| `active`/`inactive` gak bisa dihapus, cuma `draft` | Trigger `app_preset_journal_entries_delete_guard` |
| Posting cuma bisa pakai preset `active`, akun/sisi gak bisa diubah user | Guard di `create_journal_entry_from_preset` — validasi status + `line_id` harus match `preset_id` yang sama |
| Balance debit=kredit, leaf-only, atomicity, source_ref wajib (Core Invariant) tetap berlaku sama persis buat entry dari preset | `create_journal_entry_from_preset` reuse `create_journal_entry` (0003) — gak ada logic invariant yang ditulis ulang |
| RPC dasar `create_journal_entry` tetap bebas dipakai modul lain (AR/AP/Inventory) dengan akun dihitung otomatis | RPC ini gak disentuh sama sekali — larangan pilih akun bebas cuma berlaku di jalur UI Jurnal Umum |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `app_preset_journal_entry_lines` | banyak-ke-satu | `app_preset_journal_entries` |
| `app_preset_journal_entry_lines` | banyak-ke-satu (leaf only) | `accounts` |
| `create_journal_entry_from_preset` | manggil di dalamnya | `create_journal_entry` (submodule "Konsep Inti", reuse) |

## Period Closing (Tutup Buku)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| *(tidak ada tabel baru di modul ini)* | Skema penuh (ledger rentang tertutup + RPC tutup buku) dibangun di modul Financial Reports, dipakai balik ke modul ini | `docs/architecture/financial-reports-schema.md` bagian "Tutup Buku" |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tutup periode | (didefinisikan di modul Financial Reports) | Menghitung ulang saldo Revenue/Expense dari `journal_lines`, membuat closing entry lewat `create_journal_entry` (RPC modul ini, reuse), lalu mengunci rentang tanggal | Rentang harus bersambung dengan rentang terakhir yang ditutup; tidak ada jalur reopen |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Entry baru (dari modul mana pun) gak boleh masuk periode yang sudah ditutup | Trigger di `journal_entries`, ditambahkan bareng skema Period Closing di modul Financial Reports |
| Closing entry dicatat dulu, baru rentang ditandai tertutup | Urutan langkah di RPC penutup periode (modul Financial Reports) |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| Ledger rentang tertutup (modul Financial Reports) | mengunci berdasarkan tanggal | `journal_entries.entry_date` |
| Closing entry | dibuat lewat | `create_journal_entry` (modul ini, reuse) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat semua transaksi & saldo | Semua user yang sudah login |
| Membuat transaksi baru lewat Jurnal Umum | Role `admin` atau `accountant` — **wajib pakai preset**, gak ada lagi pilih akun bebas (submodule "Preset Jurnal") |
| Mengedit atau menghapus transaksi | **Tidak ada seorang pun** — hanya reversing entry yang diizinkan |
| Membuat/mengubah/mengaktifkan/menonaktifkan/menghapus preset jurnal | Role `master` doang |
| Menutup periode (hard close) | Role `admin` atau `accountant` — detail lengkap `docs/architecture/financial-reports-schema.md` |
