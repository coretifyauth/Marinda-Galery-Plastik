# Company Profile — Toko Plastik Makmur Jaya

Skenario riil yang dipakai berulang di tiap file `docs/story/*.md`. Satu bisnis yang sama, datanya nempel terus dari COA sampai Financial Reports — biar tiap modul punya konteks konkret, bukan angka acak. Beda dari dokumen lain di `docs/story/`, tujuan file-file ini **bukan cuma domain teaching** — tiap file modul ditulis sebagai tutorial jalan-jalan di UI beneran (klik menu mana, isi field apa, klik tombol apa, expected result apa), biar bisa dipakai literal buat familiarisasi UI dan uji coba UX.

## Profil Bisnis

**Toko Plastik Makmur Jaya** — toko retail + grosir perlengkapan rumah tangga berbahan plastik di Surabaya, dirintis Pak Herman tahun 2019. Mulai dari lapak kecil di pasar, sekarang punya:

- 1 toko fisik di ruko (jualan langsung ke pembeli umum, bayar cash/QRIS di tempat, kadang kartu debit) — pakai kios kasir (POS)
- 3 pelanggan grosir langganan yang ambil barang buat dijual ulang, bayar termin (gak cash di tempat) — ini yang butuh Piutang Usaha (AR)
- 2 supplier langganan buat stok barang, sering ambil dulu bayar belakangan — ini yang butuh Utang Usaha (AP)
- 1 mobil pickup buat antar barang ke pelanggan grosir + rak-rak display toko, dibeli 2024 pakai pinjaman bank
- Kadang bikin paket bundling sendiri (misal gabungan piring+gelas+sendok jadi 1 "Paket Alat Makan") — dirakit dari barang jadi lain, bukan dari bahan mentah, pakai BOM + Production Order
- Stok barang kecil-kecil (ember, gelas, sendok) gampang selisih pas dihitung fisik — rutin opname tiap akhir bulan

## Orang & Peran

| Nama | Peran di sistem | Catatan |
|---|---|---|
| Pak Herman | `admin` | Pemilik, pegang semua modul termasuk Settings/Charges & COA |
| Mbak Rina | `cashier` | Kasir toko fisik, cuma akses kios POS (`apps/pos`), gak bisa masuk `apps/erp` |

## Pelanggan Grosir (AR)

Dipakai konsisten di seluruh cerita AR — jangan ganti nama di file lain.

| Nama | Karakter dalam cerita |
|---|---|
| **Toko Kelontong Sumber Rejeki** | Pelanggan grosir paling lama, termin 30 hari, kadang telat bayar (dipakai buat cerita retur & piutang tak tertagih) |
| **Warung Bu Siti** | Pelanggan grosir kecil, sering bayar cicil / DP dulu sebelum ambil barang (dipakai buat cerita Uang Muka/DP) |
| **Toko Serba Ada Barokah** | Pelanggan grosir volume besar, kadang minta barang ditukar karena rusak saat kirim (dipakai buat cerita retur & penggantian barang) |

## Supplier (AP)

| Nama | Karakter dalam cerita |
|---|---|
| **PT Plastindo Jaya** | Pabrik plastik lokal — pemasok ember, kursi lipat, rak serbaguna. Kadang ada barang cacat produksi (dipakai buat cerita retur ke supplier) |
| **CV Sumber Plastik** | Distributor — pemasok piring, gelas, toples, alat makan plastik import. Kadang Toko Makmur Jaya kasih DP dulu buat kunci stok barang musiman (dipakai buat cerita Uang Muka Pembelian) |

## Barang (Items)

Dipakai lintas modul — Inventory, POS, AR, AP. Beberapa dijual dalam >1 satuan (multi-unit: pcs/lusin/pack).

| Nama Barang | Satuan dasar | Satuan jual lain | Catatan |
|---|---|---|---|
| Ember Plastik 10L | pcs | lusin | Item volume tinggi, sering jadi contoh goods receipt/issue |
| Kursi Plastik Lipat | pcs | — | Item bernilai lebih tinggi per unit |
| Rak Plastik Serbaguna | pcs | — | — |
| Piring Plastik | pcs | lusin, pack (isi 6) | Sering dijual pack ke retail, lusin ke grosir |
| Gelas Plastik | pcs | lusin, pack (isi 6) | Pasangan Piring Plastik buat bundling |
| Sendok-Garpu Plastik | pack (isi 12) | — | Komponen bundling |
| Toples Plastik | pcs | — | Rawan pecah/cacat — dipakai contoh barang rusak |
| **Paket Alat Makan** | pcs | — | Barang **rakitan** (BOM: 1 Piring + 1 Gelas + 1 Sendok-Garpu), dibuat lewat Production Order, bukan dibeli jadi |

## Aset Tetap

| Nama | Dibeli | Catatan |
|---|---|---|
| Mobil Pickup Antar Barang | 2024, pinjaman bank | Disusutkan tiap bulan (depresiasi) |
| Rak Display Toko | 2023 | — |

## Kenapa Butuh Sistem Ini (motivasi cerita)

Pembukuan Pak Herman tadinya di buku tulis + nota tulisan tangan. Sekarang toko makin besar (grosir + retail jalan bareng), butuh sistem biar stok gak selisih, piutang/utang ke pelanggan-supplier langganan ketagih rapi, dan suatu saat bisa ajukan pinjaman modal tambahan ke bank pakai laporan keuangan yang bener (bukan cuma catatan manual).

## Cara Pakai Story Ini

Tiap file lain di `docs/story/` ngerujuk balik ke profil ini — pakai nama pelanggan/supplier/barang yang sama, jangan improvisasi entitas baru kecuali emang perlu buat 1 skenario spesifik (kalau perlu, tetap kasih nama masuk akal & konsisten kalau dipakai ulang di file itu). Tiap file modul disusun sebagai **walkthrough UI**: bagian narasi singkat (kenapa transaksi ini terjadi dalam cerita Toko Makmur Jaya) diikuti langkah konkret — buka menu apa (sesuai sidebar grouping di `memory/preferences/ui/admin-shell-design.md`), isi field apa, klik tombol apa, apa yang harus muncul setelahnya. Ditulis buat **semua fitur yang ada di modul itu, tanpa terkecuali** — termasuk aksi-aksi transaksional yang hidup di halaman detail (retur, batalkan, terapkan DP, hanguskan, posting, dst — lihat aturan di `admin-shell-design.md`).
