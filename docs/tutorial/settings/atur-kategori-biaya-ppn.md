# Atur Kategori Biaya Tambahan & Pengaturan PPN

## Kapan Melakukan Ini

Sebelum bisa menambahkan biaya tambahan (mis. biaya packing, ongkir) di transaksi POS/AR Invoice/AP Bill, atau sebelum mengaktifkan perhitungan PPN otomatis di transaksi-transaksi itu.

## Prasyarat

- Login dengan role **admin**.
- Akun yang akan dipakai tiap kategori sudah ada di Chart of Accounts.
- Untuk PPN: tahu apakah bisnis ini PKP (Pengusaha Kena Pajak, wajib pungut PPN) dan berapa tarifnya.

## Langkah-Langkah

### Kategori Biaya/Pendapatan Tambahan

1. Buka menu **Settings** (`/settings/charges`), tab **Kategori Tambahan**.
2. Ada 3 katalog terpisah di tab ini — **Kategori Biaya Tambahan (POS)**, **Kategori Pendapatan Tambahan (AR Invoice)**, **Kategori Beban/Persediaan Tambahan (AP Bill)** — isi sesuai kebutuhan tiap sisi transaksi (satu kategori cuma berlaku di 1 sisi, tidak otomatis nyambung ke sisi lain).
3. Di katalog yang relevan, klik **+ Tambah**.
4. Isi **Nama Kategori** (mis. "Biaya Packing") dan pilih **Akun** yang akan kena dampak (debit/kredit tergantung sisi transaksinya).
5. Klik **+ Tambah**.
6. Kategori yang sudah tidak dipakai bisa **Nonaktifkan** (bukan dihapus) — kategori nonaktif tidak muncul lagi di dropdown pemilihan saat transaksi baru, tapi transaksi lama yang sudah memakainya tetap utuh.

### Pengaturan PPN

1. Klik tab **Pajak**.
2. Centang **"Kios ini wajib pungut PPN (PKP)"** kalau bisnis ini PKP — kalau tidak dicentang, checkbox PPN tidak akan muncul sama sekali di form transaksi POS/AR/AP.
3. Isi **Tarif PPN (%)**.
4. Pilih **Akun PPN Keluaran** (dipakai transaksi AR/POS — pajak dari penjualan) dan **Akun PPN Masukan** (dipakai transaksi AP — pajak dari pembelian).
5. Klik **Simpan Pengaturan Pajak**.

## Hasil Akhir

- Kategori baru langsung muncul di dropdown "Kategori Biaya/Pendapatan Tambahan" pada form terkait (POS checkout, [buat-invoice-ar.md](../accounts-receivable/buat-invoice-ar.md), [buat-bill-ap.md](../accounts-payable/buat-bill-ap.md)).
- Kalau PPN diaktifkan, checkbox "Kena PPN" langsung muncul di form-form transaksi tersebut, dengan tarif dan akun sesuai yang diatur di sini.

## Kesalahan Umum

- **Menambah kategori di katalog yang salah** — mis. menambah "Biaya Packing" di katalog AP padahal maksudnya untuk POS; tiga katalog ini terpisah total dan cuma muncul di form sisi masing-masing.
- **Mengaktifkan PPN tanpa mengisi Akun PPN Keluaran/Masukan** — checkbox PPN tetap bisa dicentang di form transaksi, tapi jurnalnya tidak akan lengkap kalau akunnya belum diisi di sini.
- **Menonaktifkan kategori yang masih dipakai rutin, mengira itu "menghapus"** — nonaktif cuma menyembunyikannya dari dropdown transaksi baru; kalau ternyata masih dibutuhkan, aktifkan kembali, tidak perlu bikin baru.
