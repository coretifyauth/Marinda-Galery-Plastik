# Default Akun — Struktur Data

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi |
|---|---|
| Default Akun | Master mapping "peran akun" (mis. Piutang Usaha, Kas Toko) ke 1 akun tetap di Chart of Accounts — dipakai form transaksi supaya user gak perlu milih akun bebas. |

> **Migration:** `supabase/migrations/0008_default_account_settings_schema.sql`. Preset Akun Aset Tetap (`fixed_asset_account_presets`) sudah dicabut total bareng seluruh modul Fixed Assets (keputusan owner) — lihat `docs/domain/general-ledger.md` bagian preset jurnal (`app_preset_journal_entries`). Submodule "Preset Akun Aset Tetap" di bawah dihapus dari dokumen ini.

## Masalah yang Diselesaikan

Untuk sebagian besar field akun di form transaksi (AR Invoice, AP Bill, Goods Issue, Goods Receipt, Production Order, Sales Order, AR/AP Deposit, Items, Stock Opname, dan sebagian besar aksi di halaman detail seperti retur/write-off/pembayaran/refund), jawabannya SELALU sama — "Akun Piutang Usaha" di form AR Invoice akan selalu akun yang sama setiap kali, gak pernah beda-beda per transaksi. Kalau field ini dibiarkan jadi dropdown bebas berisi seluruh Chart of Accounts, user (yang belum tentu paham debit/kredit) harus milih sendiri akun mana yang benar — rawan salah pilih, dan salah pilih akun di sini bikin jurnalnya salah arah.

Modul ini menutup gap itu: field-field seperti ini otomatis terisi & terkunci (read-only), user tinggal lihat, gak bisa salah pilih.

## Default Akun

**Peta Data (ERD)**
- 1 baris = 1 "peran akun" (mis. "Piutang Usaha", "Kas Toko/Kas di Bank") + akun COA yang jadi jawabannya.
- Daftar peran akunnya tetap (ditentukan lewat kode aplikasi), admin cuma bisa GANTI akun yang dipetakan ke peran itu — bukan nambah peran baru sendiri.

**Alur Teknis**
- Form transaksi baca peta ini sekali di awal, tiap field akun langsung tampil nilai terkunci sesuai perannya — gak ada langkah user pilih apa pun.
- Kalau suatu peran belum di-set admin (kasusnya harusnya jarang, semua peran yang dipakai sudah diisi dari awal), field itu tampil peringatan merah + link ke halaman Pengaturan, bukan diam-diam dikosongkan atau nampilin dropdown bebas lagi.
- 19 baris awal (daftar `role_key` di atas) sekarang dibuat lewat RPC `complete_onboarding` (lihat `coa-schema.md` submodule "Onboarding — Bootstrap Konfigurasi Awal") kalau tabel ini masih kosong — dulu cuma bisa lewat migration seed. Idempotent per `role_key` (`on conflict do nothing`), jadi aman dipanggil ulang. `account_id` di-resolve cocok `(code, name, category)` sekaligus (bukan `code` doang) — kalau kode template kebetulan sudah dipakai akun lain yang gak terkait, RPC gagal total dengan pesan jelas daripada diam-diam mapping ke akun yang salah. Mengubah akun yang sudah dipetakan tetap lewat halaman Pengaturan seperti biasa, gak lewat RPC ini.

**Aturan Bisnis → Data**
- "User gak boleh salah pilih akun" dijaga karena gak ada dropdown bebas untuk field-field ini — satu-satunya cara mengubah akun yang dipakai adalah admin masuk ke halaman Pengaturan.

**Kasus khusus: Kas/Bank** — 1 pengecualian, field "Akun Kas/Bank" tetap butuh 1 pilihan nyata dari user (tunai fisik atau transfer/QRIS), tapi pilihannya cuma 2 tombol (Tunai / Transfer Bank), bukan dropdown seluruh akun — mirip cara kios (POS) sudah kerja duluan.

**Kasus khusus: Items** — field "Akun Persediaan" di form tambah barang gak nanya sama sekali, otomatis ngikutin jenis barang (Bahan Baku/Barang Jadi) yang sudah dipilih user di field sebelumnya.

## Kasus Khusus — Retur AP Bill

Field akun kredit di panel Retur AP Bill sengaja BUKAN 1 akun tetap — harus sama dengan akun yang dipakai waktu bill itu dicatat pertama kali, dan itu bisa beda-beda tergantung isi bill-nya. Solusinya: pilihannya dibatasi cuma ke akun-akun yang beneran dipakai di bill yang sedang diretur (bukan seluruh COA) — kalau bill itu cuma pakai 1 akun, otomatis cuma ada 1 pilihan.

## Yang Sengaja Gak Disentuh

- **Journal Entries manual** — dulu jalur bebas pilih akun, sekarang **diganti preset jurnal** (`app_preset_journal_entries`, 2026-09-15) karena jalur bebas itu sendiri jadi sumber inkonsistensi buat transaksi rutin — lihat `docs/domain/general-ledger.md` submodule "Preset Jurnal".
- **Kategori pendapatan/beban tambahan** (fitur yang sudah ada sebelumnya di AR Invoice/AP Bill/POS) — tetap jalan seperti biasa, karena itu memang genuinely butuh pilihan (nama kategorinya beda-beda per transaksi).
