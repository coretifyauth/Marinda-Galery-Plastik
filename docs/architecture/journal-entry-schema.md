# General Ledger & Journal Entry — Struktur Data

Konsep bisnisnya ada di `docs/domain/general-ledger.md` — file ini fokus ke struktur data & aturan otomatis. Detail teknis: `memory/architecture/data/journal-entry-schema.md`. Akun yang dipakai bergantung ke `docs/architecture/coa-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `journal_entries` | Header 1 transaksi (tanggal, keterangan, dokumen sumber) | Bisa menunjuk ke entry lain yang dibalikkannya (reversing entry) |
| `journal_lines` | Baris debit/kredit dalam 1 transaksi | Setiap baris menunjuk ke 1 akun di Chart of Accounts |

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
| Membuat transaksi baru | Role `admin` atau `accountant` |
| Mengedit atau menghapus transaksi | **Tidak ada seorang pun** — hanya reversing entry yang diizinkan |
| Menutup periode (hard close) | Role `admin` atau `accountant` — detail lengkap `docs/architecture/financial-reports-schema.md` |
