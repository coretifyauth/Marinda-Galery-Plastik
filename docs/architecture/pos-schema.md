# POS / Jualan Eceran — Struktur Data & Teknis

Konsep bisnisnya ada di `docs/domain/pos.md`. Detail teknis penuh (DDL/trigger): `supabase/migrations/0024_pos_schema.sql`.

Sejak migration `0078`, POS gak punya tabel sendiri sama sekali lagi — penjualan kios murni komposisi tabel generic yang udah dipakai modul lain (`transactions`, `goods_notes`, `payments`). Tabel penanda sementara yang sempat ada (`pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines`, hasil unifikasi migration `0076`) dihapus total — ternyata isinya sebagian besar duplikasi data yang udah ada di tempat lain.

**Migration final (2026-09-07):** `supabase/migrations/0024_pos_schema.sql` — konsolidasi dari
migration incremental lama (sudah dihapus, historinya ada di `git log`). Nomor migration `00XX`
yang disebut di dokumen ini historis.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi buat POS | Terhubung ke |
|---|---|---|
| `transactions`/`transaction_lines` | Jurnal Piutang↔Pendapatan (+kategori tambahan+PPN) | `counterparties`, `accounts` |
| `goods_notes` (`type='OUTBOUND'`)/`goods_note_lines` | Konsumsi stok + jurnal HPP↔Persediaan + harga jual per barang | `items` |
| `payments` | Pelunasan — jurnal Kas↔Piutang, selalu lunas penuh seketika | `accounts` |
| `app_settings` (kolom `walk_in_customer_id`) | Singleton — ID customer default "Pelanggan Umum" (fallback pembeli anonim). Sejak 2026-09-14 gabungan dengan pajak+identitas perusahaan, lihat `app-settings-schema.md` | `counterparties` |
| `charge_categories` (`module='pos'`) | Katalog jenis biaya tambahan yang bisa dipilih kasir saat checkout | `accounts` |
| `app_settings` (kolom PPN) | Pengaturan PPN — 1 baris untuk seluruh sistem, dipakai bareng AP/AR | `accounts` |

## Konsep Inti

**Kenapa gak ada tabel POS lagi**: struktur penjualan kios ternyata identik penjualan termin yang lunas seketika (basket item + kategori tambahan + PPN opsional, konsumsi stok, pelunasan). Daripada punya "salinan" data buat tampilan struk, sistem sekarang baca langsung dari tabel yang sama yang jadi sumber kebenaran akuntansi/fisiknya — satu-satunya data yang genuinely gak ada tempat lain nyimpennya (harga jual per barang) dipindah jadi kolom di tabel keluar-barang yang udah ada.

**Konsekuensi desain terpenting: gak ada lagi penanda "ini transaksi dari kasir POS".** Kalau ada transaksi penjualan (lewat form mana pun) yang kebetulan berbentuk sama persis — langsung barang keluar, lunas penuh seketika, gak ada retur/DP — sistem menganggapnya SAMA dengan penjualan kios, dan ikut muncul di daftar penjualan kios. Ini keputusan sadar (bukan celah): pemilik usaha memutuskan gak perlu tahu "asal kanal" transaksi, yang penting bentuk transaksinya sama (barang keluar + lunas seketika).

**Pelanggan "walk-in" tetap 1 baris customer resmi** ("Pelanggan Umum") — gak berubah dari desain sebelumnya. Kasir gak wajib pilih siapa-siapa; sistem otomatis pakai customer default itu.

**Struktur data yang dibaca buat tampilan**

| Sumber | Isinya | Catatan |
|---|---|---|
| Baris keluar-barang | Barang, qty, harga satuan per baris | 1 transaksi boleh banyak baris (keranjang) |
| Baris jurnal transaksi | Kategori biaya tambahan + PPN | Baris "harga barang" dibedakan dari baris "beneran tambahan" lewat katalog kategori biaya resmi, bukan tebak-tebakan nominal |
| Baris jurnal pelunasan | Akun kas/bank yang dipakai bayar | Dipakai buat label "Tunai"/"Bank" |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat penjualan | `create_pos_sale` | Bikin transaksi keluar barang (konsumsi stok + jurnal Piutang↔Pendapatan + HPP↔Persediaan), lalu lunasi penuh seketika (jurnal Kas↔Piutang) — alur checkout kasir gak berubah. Sejak `promotion-item-discount-rules-schema.md`/`promotion-bundle-rules-schema.md`: RPC ini SENDIRI (bukan client) yang meresolusi diskon per barang (`promotion_item_discount_rules`) dan promo "Beli N Gratis X" (`promotion_bundle_rules`) lewat fungsi `resolve_item_discount`/`resolve_bundle_promo_discounts`, sebelum menghitung total yang dijurnal — beda dari sisi admin (Sales Order/Goods Issue) yang trust hasil resolusi client | Stok gak cukup → transaksi gagal total, gak ada yang tercatat sebagian. Diskon dari kedua mekanisme digabung per baris, dibatasi gak lebih dari nilai baris itu sendiri — HPP tetap dari cost barang keluar, gak kepengaruh diskon harga jual |
| Batalkan (Void) | `void_pos_transaction` | Membalikkan KETIGA jurnal (pelunasan, keluar barang, transaksi), stok balik | Ditolak kalau transaksinya bukan pola "penjualan kios sederhana" (persis 1 keluar-barang + 1 pelunasan penuh, tanpa retur/DP), atau udah pernah dibatalkan |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Piutang gak pernah outstanding | `create_pos_sale` selalu lunasin penuh di RPC yang sama, gak pernah nyisa |
| Stok wajib akurat real-time, gak boleh oversell | Fungsi konsumsi stok yang sama dipakai modul Inventory |
| Pembatalan cuma lewat jurnal pembalik | `void_pos_transaction` — reuse mekanisme pembalik jurnal, ditambah restore stok |
| Kasir gak pernah pilih akun pembukuan bebas | Kasir cuma pilih dari katalog kategori biaya resmi |

**Interaksi Antar Tabel**

- Konsumsi stok lewat fungsi yang sama dengan modul Inventory (Produksi, Penjualan via invoice) — 1 sumber kebenaran stok buat semua jalur keluar barang.
- Role "kasir" gak berubah — cuma bisa bikin transaksi lewat jalur resmi, gak punya akses langsung ke pencatatan jurnal umum.

## Pembatalan (Void)

Status "dibatalkan" nempel di kolom status transaksi (mesin yang sama dipakai semua jenis transaksi) — gak ada tabel/kolom status POS khusus.

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Batalkan transaksi | `void_pos_transaction` | Balikin jurnal pelunasan, keluar barang, dan transaksi — stok balik, kartu stok ikut kecatat kompensasinya | Gak ada guard "sudah ada pembayaran" (beda dari invoice termin biasa) — penjualan kios lunas seketika, jadi RPC pembatalan yang dipakai memang beda |

Pembatalan memengaruhi 3 jurnal sekaligus (pelunasan, keluar barang, transaksi) — lebih banyak dari penjualan termin biasa (1 jurnal) karena penjualan kios dari awal memang selalu langsung lunas dalam RPC yang sama.

## Riwayat Penjualan Sebelum Unifikasi

Penjualan kios yang tercatat sebelum sistem ini diunifikasi ke mesin transaksi umum **dihapus permanen** dari sistem (bukan diarsipkan) — struktur jurnalnya beda bentuk dan gak bisa "dipecah" tanpa mengubah riwayat pembukuan yang sudah tidak bisa diubah. Laporan keuangan (Neraca, Laba Rugi, dst) sama sekali gak terdampak — yang hilang cuma rincian per-item transaksi kios lama dan kemampuan membatalkannya lewat aplikasi. Daftar penjualan kios di aplikasi sekarang hanya menampilkan transaksi setelah unifikasi ini berjalan.

## Kategori Biaya Tambahan & PPN

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `charge_categories` (`module='pos'`) | Katalog jenis biaya tambahan — master data, disiapkan admin | `accounts` |
| `app_settings` (kolom PPN) | Pengaturan PPN, sama tabel dengan AP/AR — lihat `app-settings-schema.md` | `accounts` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Checkout dengan biaya tambahan | `create_pos_sale` (opsional) | Baris kredit tambahan di jurnal yang sama | Boleh kosong — mayoritas transaksi gak punya biaya tambahan |
| Checkout dengan PPN | `create_pos_sale` (opsional) | Tambahan 1 baris kredit PPN Keluaran, dihitung otomatis dari basket + biaya tambahan | Ditolak kalau PPN belum aktif atau akun PPN Keluaran belum diset |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kasir gak pernah pilih akun pembukuan bebas | Kasir cuma pilih dari daftar kategori biaya aktif |
| PPN gak boleh diketik kasir | Dihitung otomatis dari pengaturan PPN, bukan dari input checkout |
| Basket item tetap gak bisa dimanipulasi klien | Total item dihitung server dari baris keranjang |
| Biaya tambahan & PPN ikut kebalik kalau transaksi dibatalkan | Nempel di jurnal yang sama dengan basket item — `void_pos_transaction` reverse semua baris sekaligus |
