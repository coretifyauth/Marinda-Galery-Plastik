# Tukar Barang Pasca-Retur (Garansi)

## Kapan Melakukan Ini

Saat pelanggan yang barangnya sudah diretur minta **barang pengganti** (bukan uang/refund) — mis. klaim garansi. Ini langkah lanjutan dari retur yang sudah tercatat, bukan transaksi retur baru.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Sudah ada retur (AR Credit Note) yang tercatat untuk invoice ini — kalau belum, catat dulu lewat [retur-barang-ar.md](retur-barang-ar.md).
- Retur itu masih punya sisa qty yang belum ditukar.

## Langkah-Langkah

1. Buka detail invoice (`/ar-invoices/[id]`), buka daftar retur yang tercatat untuk invoice ini.
2. Klik tombol **Tukar Barang** pada retur yang relevan. Baca dulu keterangan di modal: **ini bukan gratis** — barang pengganti tetap keluar dari stok (dijurnal HPP/Persediaan), dan diskon retur yang sudah diberikan untuk item ini otomatis dibalik proporsional (Piutang Usaha naik lagi kembali), supaya piutang ke customer tidak berkurang gara-gara penukaran ini.
3. Isi **Tanggal**.
4. Untuk tiap baris item, isi **Qty Ganti** — dibatasi maksimum sisa yang belum ditukar dari retur ini.
5. Klik **Simpan Penggantian**.

## Hasil Akhir

- Barang pengganti keluar dari stok: debit HPP, kredit Persediaan Barang Jadi.
- Diskon retur yang sebelumnya mengurangi piutang untuk qty yang ditukar ini **dibalik**: debit Piutang Usaha, kredit Akun Retur & Potongan Penjualan — jadi piutang ke customer untuk qty yang ditukar itu balik seperti semula (customer tetap "berutang" untuk barang yang sekarang dia terima gantinya, bukan dapat gratis).
- Kalau retur ini kebetulan sudah punya saldo kredit aktif (dari [retur-barang-ar.md](retur-barang-ar.md) yang nominalnya melebihi outstanding), sebagian saldo kredit itu ikut dikurangi sesuai qty yang ditukar.

## Kesalahan Umum

- **Mengira penukaran barang ini gratis buat perusahaan** — tidak, barang pengganti tetap keluar dari stok dan piutangnya dipulihkan proporsional; kalau memang niatnya benar-benar gratis (bukan garansi tukar 1:1), itu transaksi lain, bukan alur ini.
- **Coba tukar lebih dari sisa qty retur** — field Qty Ganti dibatasi maksimum sisa yang belum ditukar; kalau semua item di retur itu sudah ditukar penuh, form akan menunjukkan tidak ada item tersisa untuk ditukar.
