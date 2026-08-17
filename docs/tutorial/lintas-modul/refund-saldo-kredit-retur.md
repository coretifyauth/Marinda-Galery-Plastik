# Refund Tunai Saldo Kredit Retur (AR & AP)

## Kapan Melakukan Ini

Saat sebuah retur (dari pelanggan maupun ke supplier) nilainya melebihi sisa outstanding invoice/bill terkait — kelebihannya otomatis jadi saldo kredit yang bisa dikembalikan tunai. Langkah ini untuk **mencairkan** saldo kredit itu jadi kas/bank beneran.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Sudah ada retur yang menghasilkan saldo kredit tersisa — lihat [retur-barang-ar.md](../accounts-receivable/retur-barang-ar.md) atau [retur-barang-ap.md](../accounts-payable/retur-barang-ap.md).

## Langkah-Langkah

### Sisi AR — saldo kredit ke pelanggan

1. Buka detail invoice (`/ar-invoices/[id]`) yang returnya menghasilkan saldo kredit, buka tab yang menampilkan tabel **Saldo Kredit Retur Customer**.
2. Cari baris retur dengan kolom **Sisa** masih lebih dari 0, klik tombol **Refund Tunai** di baris itu.
3. Isi **Nominal Refund** (boleh sebagian dari sisa), **Tanggal**, pilih metode **Akun Kas/Bank**.
4. Klik **Refund**.

### Sisi AP — piutang retur ke supplier

1. Buka detail bill (`/ap-bills/[id]`), buka tabel **Piutang Retur Supplier**.
2. Cari baris retur dengan **Sisa** > 0, klik **Refund Tunai**.
3. Isi **Nominal Refund**, **Tanggal**, pilih metode **Akun Kas/Bank**.
4. Klik **Refund**.

## Hasil Akhir

- **AR**: jurnal debit Akun Saldo Kredit Retur Customer, kredit Kas/Bank — kas keluar, kita mengembalikan uang ke pelanggan.
- **AP**: jurnal debit Kas/Bank, kredit Akun Piutang Retur Supplier — kas masuk, supplier mengembalikan uang ke kita.
- Refund boleh dilakukan sebagian, bertahap — kolom **Sisa** di tabel akan berkurang sesuai nominal yang sudah direfund, dan tombol **Refund Tunai** tetap tersedia selama masih ada sisa.

## Kesalahan Umum

- **Salah arah kas (Tunai vs Transfer Bank)** — pastikan metode yang dipilih sesuai kondisi fisik uang yang benar-benar berpindah.
- **Mengira saldo kredit ini otomatis cair sendiri tanpa tindakan** — tidak, ini murni liability/asset yang menunggu di neraca sampai ada tindakan eksplisit (refund tunai, atau untuk AR bisa juga dipakai untuk [tukar-barang-garansi.md](../accounts-receivable/tukar-barang-garansi.md) alih-alih direfund).
- **Refund melebihi sisa yang tercatat** — sistem membatasi berdasarkan kolom Sisa yang tersedia saat itu.
