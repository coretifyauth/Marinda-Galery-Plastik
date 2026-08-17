# Cek & Kelola Status Credit Hold Pelanggan

## Kapan Melakukan Ini

Saat pembuatan AR Invoice baru ditolak sistem karena pelanggan sedang **credit hold**, atau saat mau meninjau/menyesuaikan batas kredit pelanggan sebelum itu terjadi.

## Prasyarat

- Login (semua role bisa melihat status ini). Mengubah **Credit Limit**/**Toleransi Telat** butuh role **admin** atau **accountant**.

## Langkah-Langkah

### Cek status

1. Buka menu **Customers** (`/customers`), klik pelanggan yang mau dicek.
2. Lihat baris **Status** di detail customer — kalau ada badge merah **"Credit Hold"**, pelanggan ini sedang tertahan.
3. Credit hold terjadi otomatis kalau salah satu dari dua kondisi terpenuhi (dihitung ulang setiap saat, bukan status tetap yang tersimpan):
   - Total **Outstanding** pelanggan ini melebihi **Credit Limit** yang diset.
   - Ada invoice terbuka yang telatnya melebihi **Toleransi Telat** (hari) yang diset.

### Sesuaikan batas (kalau memang perlu diubah)

1. Di halaman yang sama, klik **Edit**.
2. Ubah **Termin (hari)**, **Credit Limit**, atau **Toleransi Telat (hari)** sesuai kebijakan baru untuk pelanggan ini — kosongkan Credit Limit/Toleransi Telat kalau memang mau menghilangkan batas itu untuk pelanggan ini (jadi "Tanpa batas").
3. Klik **Simpan**.

## Hasil Akhir

- Kalau pelanggan berstatus credit hold, **AR Invoice baru dengan termin akan ditolak sistem** sebelum sempat tercatat (bukan sekadar peringatan yang bisa dilewati) — lihat [buat-invoice-ar.md](buat-invoice-ar.md).
- Pelanggan yang sedang hold **tetap bisa dilayani asal bayar tunai langsung** (lewat kasir POS, bukan invoice bertermin) — itu jalan sebagai penjualan tunai biasa, tidak pernah jadi piutang baru.
- Status hold otomatis hilang begitu piutang lama sudah lunas/berkurang di bawah batas, atau begitu batas diperbesar — tidak perlu ada tombol khusus untuk "melepaskan" hold.

## Kesalahan Umum

- **Mencari tombol "Lepaskan Credit Hold"** — tidak ada, karena statusnya tidak disimpan sebagai data tetap; satu-satunya cara melepas hold adalah melunasi/mengurangi piutang lama, atau menaikkan Credit Limit/Toleransi Telat.
- **Menaikkan Credit Limit sangat tinggi cuma untuk melewati 1 transaksi mendesak** — pertimbangkan risikonya, karena batas baru ini berlaku terus untuk pelanggan itu sampai diubah lagi manual, bukan cuma sekali pakai.
- **Bingung kenapa pelanggan tanpa Credit Limit/Toleransi Telat diisi tidak pernah kena hold** — itu memang perilaku yang benar; kosongkan field itu berarti sengaja "tanpa batas" untuk sisi itu.
