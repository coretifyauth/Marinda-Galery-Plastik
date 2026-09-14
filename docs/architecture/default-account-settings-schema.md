# Default Akun — Struktur Data

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi |
|---|---|
| Default Akun | Master mapping "peran akun" (mis. Piutang Usaha, Kas Toko) ke 1 akun tetap di Chart of Accounts — dipakai form transaksi supaya user gak perlu milih akun bebas. |
| Preset Akun Aset Tetap | Master paket 3 akun sekaligus (Aset/Akumulasi Penyusutan/Beban Penyusutan) per jenis aset tetap. |

> **Migration final (2026-09-07, rename 2026-09-14):** `supabase/migrations/0008_default_account_settings_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas. Tabel `default_account_settings` di-rename jadi `app_default_account_settings` (prefix `app_` buat tabel config/infrastruktur cross-cutting) lewat `supabase/migrations/0029_app_prefix_rename_and_drop_signatories.sql`; `fixed_asset_account_presets` gak ikut di-rename.

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

**Aturan Bisnis → Data**
- "User gak boleh salah pilih akun" dijaga karena gak ada dropdown bebas untuk field-field ini — satu-satunya cara mengubah akun yang dipakai adalah admin masuk ke halaman Pengaturan.

**Kasus khusus: Kas/Bank** — 1 pengecualian, field "Akun Kas/Bank" tetap butuh 1 pilihan nyata dari user (tunai fisik atau transfer/QRIS), tapi pilihannya cuma 2 tombol (Tunai / Transfer Bank), bukan dropdown seluruh akun — mirip cara kios (POS) sudah kerja duluan.

**Kasus khusus: Items** — field "Akun Persediaan" di form tambah barang gak nanya sama sekali, otomatis ngikutin jenis barang (Bahan Baku/Barang Jadi) yang sudah dipilih user di field sebelumnya.

## Preset Akun Aset Tetap

**Peta Data (ERD)**
- 1 baris = 1 jenis aset tetap (mis. "Kendaraan Operasional") + 3 akun sekaligus (Aset, Akumulasi Penyusutan, Beban Penyusutan) yang harus dipakai bareng sebagai 1 paket.

**Alur Teknis**
- Beda dari Default Akun — Fixed Assets butuh 3 akun sekaligus, dan jenis aset baru tetap mungkin muncul di masa depan (gak seperti Piutang Usaha yang perannya tetap 1 selamanya). Jadi form Tambah Aset Tetap tinggal pilih 1 preset (nama jenis asetnya), bukan pilih 3 akun terpisah — mencegah salah pasang (mis. akun Aset "Rak" ketuker sama akun Akumulasi Penyusutan "Mobil").
- Admin bisa nambah preset baru kapan pun ada jenis aset baru.

**Aturan Bisnis → Data**
- "3 akun aset tetap harus konsisten sepasang" dijaga karena user cuma bisa pilih dari paket yang sudah admin siapkan, gak bisa mix-and-match 3 akun dari preset berbeda.

## Kasus Khusus — Retur AP Bill

Field akun kredit di panel Retur AP Bill sengaja BUKAN 1 akun tetap — harus sama dengan akun yang dipakai waktu bill itu dicatat pertama kali, dan itu bisa beda-beda tergantung isi bill-nya. Solusinya: pilihannya dibatasi cuma ke akun-akun yang beneran dipakai di bill yang sedang diretur (bukan seluruh COA) — kalau bill itu cuma pakai 1 akun, otomatis cuma ada 1 pilihan.

## Yang Sengaja Gak Disentuh

- **Journal Entries manual** — ini justru alat yang memang dirancang buat pilih akun bebas (dipakai admin/akuntan buat transaksi yang gak cocok pola form manapun).
- **Kategori pendapatan/beban tambahan** (fitur yang sudah ada sebelumnya di AR Invoice/AP Bill/POS) — tetap jalan seperti biasa, karena itu memang genuinely butuh pilihan (nama kategorinya beda-beda per transaksi).
