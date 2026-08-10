# Story — POS / Jualan Eceran: CV Roti Barokah

Konteks bisnis: `docs/story/company-profile.md` (poin: "1 kios kecil, jualan langsung ke pelanggan, bayar cash/QRIS di tempat"). Konsep: `docs/domain/pos.md`. ERD & DDL: belum dibangun, menyusul setelah desain data selesai.

Dibangun di luar urutan linear roadmap (Tax Handling/Fase 8 belum digarap) — kios ini sudah ada sejak awal cerita perusahaan, cuma belum pernah tercatat di sistem. Lanjutan langsung dari `docs/story/inventory.md` — posisi stok Roti Tawar per 10 September 2026: **5 buah @ avg_cost Rp1.300**.

> **Catatan latar belakang:** 30 Juli 2026, waktu Warung Pak Budi kena Credit Hold (`docs/story/accounts-receivable.md` Skenario 4), Bu Nur tetap kirim roti hari itu dan minta Pak Budi bayar cash — dicatat manual di luar sistem waktu itu (belum ada mekanisme resmi). POS sekarang jadi jalur resmi buat kejadian semacam itu.

## Harga & Akun

Kios pakai harga jual yang sama dengan harga dasar Roti Tawar (Rp2.000/buah, `item_units` di `docs/story/inventory.md`), tapi dicatat ke akun pendapatan yang **beda** dari penjualan ke warung — COA memang sudah dari awal menyediakan `4100 Pendapatan Penjualan Toko` terpisah dari `4200 Pendapatan Penjualan Grosir`, biar dua channel jualan ini kelihatan terpisah di laporan.

## Skenario 1 — Penjualan tunai biasa (12 September 2026)

Pelanggan lewat beli 2 buah Roti Tawar, bayar tunai. Walk-in, gak ada `customer_id`.

```
Debit Kas Toko                    4.000
  Kredit Pendapatan Penjualan Toko        4.000

Debit Harga Pokok Penjualan       2.600   (2 buah × Rp1.300 avg_cost)
  Kredit Persediaan Barang Jadi            2.600
```

`inventory_balances` Roti Tawar: qty_on_hand 5 → **3 buah** (avg_cost tetap Rp1.300). Laba kotor: Rp4.000 − Rp2.600 = **Rp1.400**.

## Skenario 2 — Penjualan QRIS (12 September 2026)

Pelanggan lain beli 1 buah, bayar QRIS — uangnya masuk rekening bank, bukan laci kas fisik.

```
Debit Kas di Bank                 2.000
  Kredit Pendapatan Penjualan Toko        2.000

Debit Harga Pokok Penjualan       1.300
  Kredit Persediaan Barang Jadi            1.300
```

`inventory_balances` Roti Tawar: qty_on_hand 3 → **2 buah**.

## Skenario 3 — Ditolak karena stok gak cukup (12 September 2026)

Rombongan pelanggan mau beli 5 buah sekaligus. Stok tersisa cuma 2 buah.

`create_pos_sale` cek stok real-time ke `inventory_balances` SEBELUM bikin jurnal apa pun — 5 > 2, `raise exception`. Transaksi gak jadi tercatat sama sekali (no partial write), kasir kasih tau pelanggan stok gak cukup. Ini persis alasan checkout POS wajib online (`docs/domain/pos.md`, `memory/scope-debt/pos-offline-capability.md`) — kalau devicenya sempat kerja dari data stok yang gak ter-update, dua kasir/dua pelanggan bisa sama-sama "berhasil" checkout barang yang sama padahal stoknya cuma cukup buat satu.

## Skenario 4 — Pembatalan (Void), kasir salah input (12 September 2026)

Kasir sadar transaksi Skenario 2 salah — pelanggan sebenarnya bayar tunai, bukan QRIS (salah pencet metode bayar). Transaksi dibatalkan lewat `void_pos_sale`, dicatat ulang yang benar.

```
Debit Pendapatan Penjualan Toko   2.000
  Kredit Kas di Bank                       2.000

Debit Persediaan Barang Jadi      1.300
  Kredit Harga Pokok Penjualan             1.300
```

`inventory_balances` Roti Tawar: qty_on_hand 2 → **3 buah** (balik). Transaksi Skenario 2 tetap ada di histori (bukan dihapus), status "dibatalkan" — kasir input ulang transaksi yang benar (1 buah, tunai) sebagai POS Sale baru, jurnalnya sama pola Skenario 1 tapi nominal Rp2.000/Rp1.300. `inventory_balances` Roti Tawar akhirnya qty_on_hand **2 buah**.

## Skenario 5 — Cash sale dikaitkan ke customer AR existing (13 September 2026)

Pak Budi mampir langsung ke kios (bukan lewat jalur kirim ke warungnya), beli 1 buah Roti Tawar buat dimakan sendiri, bayar tunai. Kasir mengaitkan transaksi ini ke `customer_id` Pak Budi yang sudah terdaftar di AR — murni buat riwayat/traceability ("Pak Budi ini pelanggan lama"), **bukan** berarti transaksi ini jadi piutang. Jurnalnya identik Skenario 1 (Debit Kas Toko / Kredit Pendapatan Penjualan Toko, plus HPP/Persediaan), cuma baris `pos_sales.customer_id` terisi. Gak nyentuh `ar_invoices`/`ar_payments` sama sekali, gak kepengaruh status Credit Hold Pak Budi di AR.

```
Debit Kas Toko                    2.000
  Kredit Pendapatan Penjualan Toko        2.000

Debit Harga Pokok Penjualan       1.300
  Kredit Persediaan Barang Jadi            1.300
```

`inventory_balances` Roti Tawar: qty_on_hand 2 → **1 buah**.

## Posisi Akhir per 13 September 2026

| Item | Sisa Qty | Nilai Persediaan |
|---|---|---|
| Roti Tawar (barang jadi, Weighted Avg) | 1 buah @ Rp1.300 | **Rp1.300** |

Pendapatan Penjualan Toko (kumulatif skenario di atas, net dari void): Rp4.000 (Skenario 1) + Rp2.000 (Skenario 4, transaksi pengganti) + Rp2.000 (Skenario 5) = **Rp8.000**. Kas Toko bertambah Rp6.000 (Skenario 1 + pengganti Skenario 4), Kas di Bank net **Rp0** (Skenario 2 dan pembalikannya di Skenario 4 saling meniadakan).

## Interface (sudah dibangun, 2026-08-09; diperluas 2026-08-10)

App `apps/pos` (checkout kasir, laptop/desktop, layout sendiri tanpa admin shell, login sendiri) — layar tunggal: klik item buat nambah ke keranjang, keranjang jalan (running total, +/− qty per baris), pilih metode bayar (Tunai/QRIS), opsional pilih customer, tombol checkout manggil `create_pos_sale`. Riwayat transaksi ada di `apps/erp` — `/pos-sales` (list, grup sidebar baru "POS/Retail") + `/pos-sales/[id]` (detail: rincian baris item, 2 jurnal terkait, tombol "Batalkan" buat admin/accountant manggil `void_pos_sale`).

Sejak 2026-08-10, checkout kasir juga punya baris "Biaya Tambahan" (pilih kategori dari katalog + isi nominal, bisa lebih dari 1 baris) dan checkbox "Kena PPN" (cuma muncul kalau admin sudah mengaktifkan PPN). Admin mengelola katalog kategori & Pengaturan Pajak di `apps/erp` `/settings/charges` (grup sidebar baru "Settings").

## Skenario 6 — Biaya Packing + PPN dalam 1 Transaksi (14 September 2026, ilustrasi)

**Catatan:** skenario ini murni ilustrasi cara kerja fitur "Kategori Biaya Tambahan & PPN" (migration `0025_compound_transactional_entries_schema.sql`) — CV Roti Barokah di cerita ini **belum** benar-benar terdaftar PKP (`tax_settings.is_active` tetap `false` secara default), jadi bagian PPN di bawah bersifat andaikata.

Setelah restock produksi tambahan (mekanisme sama seperti `Tahap 6`/Sales Order `Tahap 9`), stok Roti Tawar cukup untuk pesanan borongan 10 buah, avg_cost tetap Rp1.300/buah. Pelanggan minta dibungkus rapi pakai kotak (kena **biaya packing Rp1.000**, kategori terpisah dari harga roti), dan diandaikan kios ini sudah PKP sehingga kena **PPN 11%**.

Sebelum transaksi ini, Bu Nur sudah menyiapkan 1 kategori di halaman Pengaturan: "Biaya Packing" → akun `Pendapatan Jasa Packing`. Perhitungan: barang 10×Rp2.000 = Rp20.000, packing Rp1.000, dasar pengenaan pajak = Rp21.000, PPN 11% = Rp2.310.

```
Debit Kas Toko                          23.310
  Kredit Pendapatan Penjualan Toko               20.000
  Kredit Pendapatan Jasa Packing                  1.000
  Kredit PPN Keluaran                             2.310

Debit Harga Pokok Penjualan             13.000   (10 × Rp1.300)
  Kredit Persediaan Barang Jadi                   13.000
```

Kasir cuma memilih "Biaya Packing" dari daftar + isi nominal, dan mencentang "Kena PPN" — PPN-nya sendiri dihitung otomatis, bukan diketik. Kalau transaksi ini salah input dan dibatalkan lewat `void_pos_sale`, KETIGA baris kredit (Pendapatan, Packing, PPN) ikut terbalik sekaligus — beda dari interim lama yang pernah dipertimbangkan (jurnal PPN manual terpisah, gak nempel ke `pos_sales` mana pun dan gak ikut kebalik otomatis).

## Lanjutan Story

Kebijakan retur kios masih belum diputuskan Bu Nur (`memory/special-case/pos-retur-policy.md`) — begitu diputuskan, submodule baru bakal ditambahkan di sini.
