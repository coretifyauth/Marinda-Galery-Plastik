# Tambah Supplier Baru

## Kapan Melakukan Ini

Sebelum membuat AP Bill pertama dari supplier yang belum pernah dicatat di sistem.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Tahu termin pembayaran yang diberikan supplier ini (berapa hari sejak bill diterima sampai jatuh tempo).

## Langkah-Langkah

1. Buka menu **Suppliers** (`/suppliers`).
2. Klik tombol **+ New**. Modal **Tambah Supplier** terbuka.
3. Isi field:
   - **Nama** — nama supplier.
   - **Kontak** — nomor telepon/WA (opsional).
   - **Termin (hari)** — jumlah hari sejak tanggal bill sampai jatuh tempo (ditentukan supplier, bukan kita). Default `14`.
4. Klik **Simpan**.

## Hasil Akhir

Supplier baru muncul di daftar dan langsung bisa dipilih di dropdown **Supplier** saat membuat AP Bill. Sama seperti customer, `due_date` bill ke supplier ini dihitung otomatis dari Termin **saat bill dibuat** (snapshot) — perubahan Termin supplier belakangan tidak mengubah bill lama.

## Kesalahan Umum

- **Ubah Termin supplier dan berharap bill lama ikut berubah jatuh temponya** — tidak akan berubah, itu snapshot per bill, sama seperti di AR.
