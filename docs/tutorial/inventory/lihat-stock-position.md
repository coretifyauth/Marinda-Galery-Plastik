# Lihat Stock Position (Kartu Stok Semua Item)

## Kapan Melakukan Ini

Kapan pun butuh cek posisi stok & nilai persediaan seluruh barang secara sekilas — sebelum membuat Purchase Order/Production Order (cek stok cukup atau tidak), atau untuk laporan nilai persediaan ke pihak lain.

## Prasyarat

- Login (semua role bisa akses, halaman ini murni baca).

## Langkah-Langkah

1. Buka menu **Stock Position** (`/inventory`).
2. Halaman langsung menampilkan tabel semua item: **Item**, **Avg Cost** (harga rata-rata per unit, Weighted Average), **Qty Tersisa**, **Nilai Persediaan** (Avg Cost × Qty Tersisa).
3. Kalau baru saja ada transaksi (GRN/Goods Issue/Stock Opname/Production) dan angkanya belum terlihat ter-update, klik tombol **Refresh**.
4. Lihat **Grand Total** di bawah tabel untuk nilai total seluruh persediaan.

## Hasil Akhir

Halaman ini **tidak mencatat apa pun** — murni menampilkan data terkini dari `inventory_balances`, hasil turunan dari semua transaksi inventory yang sudah tercatat (PO+GRN, Production Order, Goods Issue, Stock Opname).

## Kesalahan Umum

- **Mencari form input di halaman ini** — tidak ada, ini murni read-only; kalau butuh menyesuaikan stok, itu lewat [stock-opname.md](stock-opname.md), bukan dari sini.
- **Bingung angka belum berubah setelah transaksi baru** — coba klik **Refresh**; data tidak auto-refresh terus-menerus, cuma dimuat ulang tiap halaman dibuka atau tombol itu diklik.
