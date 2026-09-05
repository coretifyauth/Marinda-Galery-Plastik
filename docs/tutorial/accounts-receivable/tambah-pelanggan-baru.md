# Tambah Pelanggan (Customer) Baru

## Kapan Melakukan Ini

Sebelum membuat AR Invoice pertama ke pelanggan yang belum pernah dicatat di sistem.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Tahu termin pembayaran yang disepakati dengan pelanggan ini (berapa hari sejak invoice terbit).

## Langkah-Langkah

1. Buka menu **Customers** (`/customers`).
2. Klik tombol **+ New**. Modal **Tambah Customer** terbuka.
3. Isi field:
   - **Nama** — nama pelanggan/toko.
   - **Kontak** — nomor telepon/WA (opsional).
   - **Termin (hari)** — jumlah hari sejak tanggal invoice sampai jatuh tempo. Default `7`.
4. Klik **Simpan**.

## Hasil Akhir

- Customer baru muncul di daftar dan langsung bisa dipilih di dropdown **Customer** saat membuat AR Invoice.
- `due_date` invoice ke customer ini nanti dihitung otomatis dari **Termin** yang diisi di sini — tapi cuma dihitung sekali saat invoice dibuat (snapshot). Kalau termin customer diubah belakangan, invoice yang sudah ada **tidak ikut berubah** jatuh temponya.

## Kesalahan Umum

- **Ubah Termin customer dan berharap invoice lama ikut berubah jatuh temponya** — tidak akan berubah, itu snapshot per invoice.
