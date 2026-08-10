# POS / Jualan Eceran — Struktur Data & Teknis

Konsep bisnisnya ada di `docs/domain/pos.md`. Skenario nyata: `docs/story/pos.md`. Detail teknis penuh (DDL/trigger): `memory/architecture/data/pos-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `pos_sales` | 1 transaksi kasir tunai di kios — header, gak pernah nyentuh Piutang Usaha | `customers` (opsional), `accounts` (akun kas & pendapatan), 2 transaksi jurnal (Kas/Pendapatan dan HPP/Persediaan) |
| `pos_sale_lines` | Baris item per transaksi (barang, qty, harga, biaya pokok) | `pos_sales`, `items` |
| `pos_sale_extra_credit_lines` | Rincian baris kredit tambahan (biaya packing/ongkir + PPN) 1 transaksi, kalau ada | `pos_sales` (banyak-ke-satu) |
| `pos_charge_types` | Katalog jenis biaya tambahan yang bisa dipilih kasir saat checkout — master data, disiapkan admin | `accounts` |
| `tax_settings` | Pengaturan PPN — 1 baris untuk seluruh sistem, dipakai bareng AP/AR, didefinisikan penuh di `docs/architecture/ar-schema.md` | `accounts` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `pos_sales` | Penjualan tunai kios | `customers` (opsional), `accounts`, transaksi jurnal |
| `pos_sale_lines` | Rincian barang per transaksi | `pos_sales`, `items` |

**Struktur `pos_sales`**

| Kolom | Isinya | Catatan |
|---|---|---|
| pelanggan | Opsional — boleh dikaitkan ke pelanggan AR existing (buat riwayat), boleh kosong (walk-in anonim) | Gak pernah bikin baris di `ar_invoices` apa pun isinya |
| tanggal, akun kas | Kapan transaksi terjadi, akun mana yang kena debit | Akun beda tergantung metode bayar — tunai fisik vs QRIS/transfer masuk akun berbeda |
| akun pendapatan | Kredit selalu ke akun "Pendapatan Penjualan Toko" — terpisah dari akun grosir yang dipakai AR | |
| total | **Tidak disimpan sebagai parameter dari client** — dihitung server-side dari jumlah semua baris item (qty × harga satuan) | Beda dari pola AR+Goods Issue yang masih nerima total mentah dari pemanggil. Biaya tambahan & PPN (lihat submodule "Kategori Biaya Tambahan & PPN" di bawah) di luar angka ini, ditambahkan terpisah |

**Struktur `pos_sale_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| barang, qty, harga satuan | Rincian per jenis barang dalam 1 transaksi | 1 transaksi boleh banyak baris (keranjang) |
| biaya pokok | Dihitung dari Rata-Rata Tertimbang barang itu, saat transaksi terjadi | Sumber baris HPP di jurnal kedua |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat penjualan | `create_pos_sale` | Konsumsi stok tiap barang (Rata-Rata Tertimbang), 2 jurnal sekaligus (Kas/Bank↔Pendapatan, HPP↔Persediaan), insert header+baris | Stok gak cukup → transaksi gagal total, gak ada yang tercatat sebagian (no partial write) |
| Batalkan (Void) | `void_pos_sale` | Membalikkan KEDUA jurnal, stok balik ke posisi semula | Ditolak kalau udah pernah dibatalkan, atau tanggalnya masuk periode yang sudah ditutup |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Piutang Usaha gak pernah kesentuh | `create_pos_sale` gak pernah insert ke `ar_invoices` |
| Stok wajib akurat real-time, gak boleh oversell | Fungsi konsumsi stok yang sama dipakai modul Inventory — raise error kalau stok kurang, SEBELUM jurnal apa pun dibuat |
| Pembatalan cuma lewat jurnal pembalik | `void_pos_sale` — reuse mekanisme pembalik jurnal yang sama dipakai AR |
| Transaksi ke periode tertutup ditolak | Reuse aturan umum integritas pembukuan (berlaku otomatis ke semua modul, gak ada aturan baru) |
| Penjualan kios & penjualan grosir kelihatan terpisah di laporan | Akun pendapatan beda — POS selalu ke "Pendapatan Penjualan Toko" |

**Interaksi Antar Tabel**

- `pos_sales` opsional menunjuk `customers` — kalau diisi, murni riwayat/traceability, gak pernah memicu pengecekan Tahan Kredit (itu cuma berlaku buat `ar_invoices`).
- `pos_sale_lines` menunjuk `items`, pakai fungsi konsumsi stok yang sama dengan modul Inventory (Produksi, Penjualan via invoice) — 1 sumber kebenaran stok buat semua jalur keluar barang.
- Role baru "kasir" ditambahkan khusus buat modul ini — cuma bisa bikin transaksi lewat jalur resmi (`create_pos_sale`), gak punya akses langsung ke pencatatan jurnal umum.

## Pembatalan (Void)

**Peta Data (ERD)**

Gak ada tabel baru — status "dibatalkan" dibaca dari ada-tidaknya jurnal pembalik, bukan kolom tersendiri (pola sama seperti pembatalan invoice AR).

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Batalkan transaksi | `void_pos_sale` | Balikin jurnal Kas/Pendapatan dan HPP/Persediaan, stok balik | Gak ada guard "sudah ada pembayaran" (beda dari AR) — penjualan kios lunas seketika di titik transaksi dibuat |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Transaksi asli gak pernah diedit/dihapus | RLS tanpa policy update/delete + trigger penjaga (reuse pola tabel transaksional lain) |
| Gak bisa dibatalkan dua kali | `void_pos_sale` cek dulu ada-tidaknya jurnal pembalik sebelum lanjut |

**Interaksi Antar Tabel**

- Pembatalan memengaruhi 2 transaksi jurnal sekaligus (beda dari AR yang biasanya cuma 1), karena 1 penjualan POS dari awal memang selalu punya 2 jurnal.

## Kategori Biaya Tambahan & PPN

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `pos_sale_extra_credit_lines` | Rincian baris kredit tambahan (biaya packing/ongkir + PPN) 1 transaksi kasir | `pos_sales` (banyak-ke-satu) |
| `pos_charge_types` | Katalog jenis biaya tambahan — master data, disiapkan admin | `accounts` |
| `tax_settings` | Pengaturan PPN, sama tabel dengan AP/AR (`docs/architecture/ar-schema.md`) | `accounts` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Checkout dengan biaya tambahan | `create_pos_sale` (`p_extra_credit_lines`, opsional) | Baris kredit tambahan di jurnal Kas↔Pendapatan yang sama, insert `pos_sale_extra_credit_lines` | Boleh kosong — mayoritas transaksi gak punya biaya tambahan |
| Checkout dengan PPN | `create_pos_sale` (`p_apply_tax=true`) | Tambahan 1 baris kredit PPN Keluaran, dihitung otomatis dari basket + biaya tambahan | Ditolak kalau `tax_settings.is_active=false` atau akun PPN Keluaran belum diset |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kasir gak pernah pilih akun pembukuan bebas | Kasir cuma pilih dari daftar `pos_charge_types` aktif — RPC tetap terima `account_id` mentah, tapi UI checkout gak pernah kasih kasir akses ke seluruh daftar akun |
| PPN gak boleh diketik kasir | `create_pos_sale` menghitung sendiri dari `tax_settings`, bukan dari input checkout |
| Basket item tetap gak bisa dimanipulasi klien | `p_revenue_account_id`/total item TETAP dihitung server dari `p_lines`, gak berubah oleh fitur ini |
| Biaya tambahan & PPN ikut kebalik kalau transaksi dibatalkan | Sama jurnal (`revenue_journal_entry_id`) dengan basket item — `void_pos_sale` reverse semua baris sekaligus, gak perlu diubah |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `pos_sale_extra_credit_lines` | banyak-ke-satu | `pos_sales` |
| `pos_charge_types` | referensi (dipakai UI checkout, bukan FK langsung) | `pos_sale_extra_credit_lines` |
