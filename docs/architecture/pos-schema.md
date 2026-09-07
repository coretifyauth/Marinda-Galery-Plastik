# POS / Jualan Eceran — Struktur Data & Teknis

Konsep bisnisnya ada di `docs/domain/pos.md`. Detail teknis penuh (DDL/trigger): `memory/architecture/data/pos-schema.md`.

Sejak migration `0076`/`0077`, POS diunifikasi ke `transactions`/`goods_issues`/`payments` (mesin yang sama dipakai AR Invoice/AP Bill) — bukan lagi tabel berdiri sendiri. `pos_sales` sekarang cuma penanda tipis, bukan header transaksi. Ada rencana simplifikasi lanjutan yang ditunda (drop `pos_sales`/`pos_sale_lines`/`pos_sale_extra_credit_lines`, rely penuh ke `goods_issue_lines`+`transaction_lines`) — lihat `memory/scope-debt/pos-sales-simplify-rely-on-goods-issue.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `pos_sales` | Penanda "transaksi ini lahir dari kasir POS" + pointer ke 3 baris yang harus dibatalkan bareng — BUKAN header finansial | `transactions` (1-ke-1), `goods_issues`, `payments`, `accounts` (akun kas) |
| `pos_sale_lines` | Salinan item buat cetak struk (harga jual per baris) — bukan sumber kebenaran akuntansi | `pos_sales`, `items` |
| `pos_sale_extra_credit_lines` | Salinan baris kredit tambahan (biaya packing/ongkir + PPN) buat struk | `pos_sales` (banyak-ke-satu) |
| `pos_settings` | Singleton — nyimpen ID counterparty "Pelanggan Umum" (fallback pelanggan walk-in) | `counterparties` |
| `charge_categories` (`module='pos'`) | Katalog jenis biaya tambahan yang bisa dipilih kasir saat checkout — master data, disiapkan admin | `accounts` |
| `tax_settings` | Pengaturan PPN — 1 baris untuk seluruh sistem, dipakai bareng AP/AR | `accounts` |

## Konsep Inti

**Kenapa berubah**: struktur jurnal POS ternyata identik penjualan termin ("debit 1 akun kontrol, kredit N baris variabel + PPN opsional") — bedanya cuma POS lunas seketika, gak pernah nyisa piutang outstanding. Daripada dipertahankan sebagai mesin terpisah, `create_pos_sale` sekarang jadi orkestrator 2 langkah resmi yang sudah ada di sistem: bikin transaksi keluar barang (jurnal Piutang↔Pendapatan + HPP↔Persediaan), lalu langsung lunasi penuh (jurnal Kas↔Piutang). Dari sisi kasir, alur checkout **sama sekali gak berubah** — tombol dan form yang sama, cuma mesin di baliknya yang beda.

**Konsekuensi konseptual penting**: penjualan kios sekarang SECARA TEKNIS numpang lewat Piutang Usaha sesaat sebelum langsung dilunasi RPC yang sama — beda dari desain awal (debit Kas langsung, gak pernah nyentuh Piutang sama sekali). Efek akhir buat pemilik usaha tetap sama (gak pernah kelihatan piutang outstanding dari kios), ini murni detail mesin di balik layar.

**Pelanggan "walk-in" jadi 1 baris customer resmi.** Karena tiap transaksi tetap wajib terhubung ke 1 customer (aturan umum yang berlaku semua modul), kios butuh 1 customer default buat pembeli yang gak disebut identitasnya — namanya "Pelanggan Umum", disiapkan otomatis, kasir gak perlu pilih apa-apa kalau pembelinya anonim. Baris ini sengaja gak dibedakan tampilannya dari customer biasa (biar tetap kelihatan di daftar customer buat audit), tapi disembunyikan dari dropdown pilih customer di form transaksi kredit sungguhan (biar gak kepilih gak sengaja buat invoice termin beneran).

**Struktur `pos_sales`, `pos_sale_lines`, `pos_sale_extra_credit_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| pointer ke transaksi/goods issue/payment | Nunjuk ke 3 baris resmi yang menyimpan angka sebenarnya | Dipakai buat tahu apa yang harus dibalik bareng kalau dibatalkan |
| barang, qty, harga satuan | Rincian per jenis barang, disalin buat cetak struk | Angka aslinya tetap di `transaction_lines`/`goods_issue_lines`, ini cuma salinan tampilan |
| biaya tambahan & PPN | Salinan baris kredit tambahan, buat struk juga | Angka aslinya tetap di `transaction_lines` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat penjualan | `create_pos_sale` | Bikin transaksi keluar barang (konsumsi stok + jurnal Piutang↔Pendapatan + HPP↔Persediaan), lalu lunasi penuh seketika (jurnal Kas↔Piutang) — alur checkout kasir gak berubah | Stok gak cukup → transaksi gagal total, gak ada yang tercatat sebagian |
| Batalkan (Void) | `void_pos_transaction` | Membalikkan KETIGA jurnal (pelunasan, keluar barang, transaksi), stok balik | Ditolak kalau udah pernah dibatalkan, atau transaksinya bukan penjualan POS |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Piutang gak pernah outstanding (walau numpang sesaat) | `create_pos_sale` selalu lunasin penuh di RPC yang sama, gak pernah nyisa |
| Stok wajib akurat real-time, gak boleh oversell | Fungsi konsumsi stok yang sama dipakai modul Inventory — raise error kalau stok kurang, SEBELUM jurnal apa pun dibuat |
| Pembatalan cuma lewat jurnal pembalik | `void_pos_transaction` — reuse mekanisme pembalik jurnal yang sama dipakai AR, ditambah restore stok |
| Transaksi ke periode tertutup ditolak | Reuse aturan umum integritas pembukuan |
| Penjualan kios & penjualan grosir kelihatan terpisah di laporan | Akun pendapatan beda — POS selalu ke "Pendapatan Penjualan Toko" |

**Interaksi Antar Tabel**

- `pos_sales` gak lagi opsional menunjuk customer — sekarang WAJIB (fallback "Pelanggan Umum" kalau kasir gak pilih), tapi ini tetap gak pernah memicu Tahan Kredit (guard itu cuma jalan buat invoice termin, bukan penjualan yang lunas seketika).
- Konsumsi stok lewat fungsi yang sama dengan modul Inventory (Produksi, Penjualan via invoice) — 1 sumber kebenaran stok buat semua jalur keluar barang.
- Role "kasir" gak berubah — cuma bisa bikin transaksi lewat jalur resmi (`create_pos_sale`), gak punya akses langsung ke pencatatan jurnal umum.

## Pembatalan (Void)

**Peta Data (ERD)**

Gak ada tabel status baru — status "dibatalkan" nempel di kolom `transactions.status` (mesin yang sama dipakai semua jenis transaksi), `pos_sales_with_status` tinggal baca kolom itu.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Batalkan transaksi | `void_pos_transaction` | Balikin jurnal pelunasan, keluar barang, dan transaksi — stok balik, Kartu Stok ikut kecatat kompensasinya | Gak ada guard "sudah ada pembayaran" (beda dari AR) — penjualan kios lunas seketika di titik transaksi dibuat, jadi RPC pembatalan yang dipakai memang beda dari invoice termin |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Transaksi asli gak pernah diedit/dihapus | RLS tanpa policy update/delete + trigger penjaga |
| Gak bisa dibatalkan dua kali | `void_pos_transaction` cek dulu ada-tidaknya jurnal pembalik sebelum lanjut |

**Interaksi Antar Tabel**

- Pembatalan memengaruhi 3 jurnal sekaligus (pelunasan, keluar barang, transaksi) — lebih banyak dari AR biasa (1 jurnal) karena penjualan kios dari awal memang selalu langsung lunas dalam RPC yang sama.

## Riwayat Penjualan Sebelum Unifikasi (Pra-`0076`)

Penjualan kios yang tercatat sebelum migration unifikasi **dihapus permanen** dari sistem (bukan diarsipkan) — struktur jurnalnya beda bentuk dari desain baru dan gak bisa "dipecah" tanpa mengubah riwayat pembukuan yang sudah immutable. Laporan keuangan (Neraca, Laba Rugi, dst) sama sekali gak terdampak (jurnalnya tetap utuh di tempat lain) — yang hilang cuma kemampuan melihat rincian per-item transaksi kios lama dan membatalkannya lewat aplikasi (koreksi transaksi lama, kalau dibutuhkan, harus manual lewat Jurnal Umum). Daftar penjualan kios di aplikasi sekarang hanya menampilkan transaksi setelah unifikasi ini berjalan.

## Kategori Biaya Tambahan & PPN

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `pos_sale_extra_credit_lines` | Salinan baris kredit tambahan (biaya packing/ongkir + PPN) buat tampilan struk | `pos_sales` (banyak-ke-satu) |
| `charge_categories` (`module='pos'`) | Katalog jenis biaya tambahan — master data, disiapkan admin | `accounts` |
| `tax_settings` | Pengaturan PPN, sama tabel dengan AP/AR (`docs/architecture/tax-settings-schema.md`) | `accounts` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Checkout dengan biaya tambahan | `create_pos_sale` (`p_extra_credit_lines`, opsional) | Baris kredit tambahan di jurnal yang sama, disalin ke `pos_sale_extra_credit_lines` buat struk | Boleh kosong — mayoritas transaksi gak punya biaya tambahan |
| Checkout dengan PPN | `create_pos_sale` (`p_apply_tax=true`) | Tambahan 1 baris kredit PPN Keluaran, dihitung otomatis dari basket + biaya tambahan | Ditolak kalau `tax_settings.is_active=false` atau akun PPN Keluaran belum diset |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kasir gak pernah pilih akun pembukuan bebas | Kasir cuma pilih dari daftar `charge_categories` (`module='pos'`) aktif |
| PPN gak boleh diketik kasir | Dihitung otomatis dari `tax_settings`, bukan dari input checkout |
| Basket item tetap gak bisa dimanipulasi klien | Total item dihitung server dari baris keranjang, gak berubah oleh fitur ini |
| Biaya tambahan & PPN ikut kebalik kalau transaksi dibatalkan | Nempel di jurnal yang sama dengan basket item — `void_pos_transaction` reverse semua baris sekaligus |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `pos_sale_extra_credit_lines` | banyak-ke-satu | `pos_sales` |
| `charge_categories` (`module='pos'`) | referensi (dipakai UI checkout, bukan FK langsung) | `pos_sale_extra_credit_lines` |
