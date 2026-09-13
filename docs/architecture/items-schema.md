# Master Barang (Items) — Struktur Data

Master data barang yang dilacak modul Inventory — bahan baku maupun barang jadi. Konsep bisnisnya ada di `docs/domain/inventory.md` (bagian "Kategori & Brand Barang", "Satuan Jual & Harga (Multi Unit of Measure)", dan "Kode Scan Barang"). File ini fokus ke bagaimana datanya disimpan dan aturan apa yang dijaga otomatis oleh sistem. Detail teknis (SQL, nama fungsi persis) ada di `supabase/migrations/0005_items_schema.sql`. Posisi stok & mutasi per item ada di `inventory-ledger-schema.md`, bukan di sini — file ini murni master data barang.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `items` | Master barang itu sendiri — nama, satuan dasar, jenis, akun Persediaan | `accounts` (akun kontrol Persediaan), `item_categories`, `item_brands` |
| `item_categories` | Katalog kategori barang (opsional) | `items` |
| `item_brands` | Katalog merek/brand barang (opsional) | `items` |
| `item_units` | Satuan jual per barang (bisa lebih dari 1), tiap satuan punya harga & kode scan sendiri | `items` |

> **Migration final (2026-09-07):** `supabase/migrations/0005_items_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `items` | Master barang — bisa bahan baku (`RAW_MATERIAL`) atau barang jadi (`FINISHED_GOOD`) | `accounts.inventory_account_id`, `item_categories`, `item_brands` |

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `uom` | Satuan dasar (kg, gram, pcs, dst) | Satu-satunya satuan yang dipakai buat pelacakan stok/costing (PO, terima barang, BOM, produksi, jual barang). Satuan jual tambahan (`item_units`) gak pernah menggantikan ini |
| `inventory_account_id` | Akun Persediaan di Chart of Accounts | Akun **kontrol** — 1 akun ini menaungi banyak item sekaligus, rincian per-item ada di subledger Inventory, bukan akun terpisah per barang di COA (pola sama seperti 1 akun "Piutang Usaha" menaungi banyak customer) |
| `category_id`, `brand_id` | Rujukan ke katalog kategori/brand | Opsional & independen satu sama lain — barang boleh gak punya salah satu, keduanya, atau tidak sama sekali |
| `archived_at` | Tanggal arsip | Barang yang sudah pernah dipakai gak bisa dihapus keras, cuma diarsipkan |
| `created_by` | Email pembuat baris (snapshot, bukan FK ke `auth.users`) | Nullable — `NULL` di baris lama atau insert dari luar jalur aplikasi (Studio/service-role). Kolom sama juga ada di `item_units`/`item_categories`/`item_brands` |

Penamaan tabel ini polos (`items`, bukan `inventory_items`) karena konvensi project: master data gak pakai prefix modul, cuma tabel transaksional yang pakai — pola yang sama juga dipakai `counterparties`.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tambah/ubah barang | — (insert/update langsung ke tabel, bukan financial write) | Insert/update baris `items` | RLS: `insert` hanya `admin`, `update` juga termasuk buat mengisi `archived_at` |
| Hapus barang | Fungsi `delete_item()` | Barang yang belum pernah dipakai transaksi apa pun → dihapus permanen. Barang yang sudah pernah dipakai → diarsipkan otomatis sebagai fallback | `security definer`, bagian dari mekanisme "Smart Delete Master Data" yang sama dipakai tabel master lain (lihat `coa-schema.md`) |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Barang lama gak boleh dihapus keras kalau sudah pernah dipakai | Fungsi `delete_item()` — hapus permanen cuma berhasil kalau belum ada referensi apa pun, kalau ada otomatis diarsipkan |
| Satuan dasar tetap jadi acuan tunggal pelacakan stok, gak berubah walau barang punya banyak satuan jual | Kolom `items.uom` tidak disentuh oleh fitur `item_units` — semua RPC transaksi (order, terima barang, jual barang, produksi, stock opname) tetap menerima qty di satuan dasar |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `items.inventory_account_id` | banyak-ke-satu | `accounts` (COA) |
| `items.category_id` | banyak-ke-satu, opsional | `item_categories` |
| `items.brand_id` | banyak-ke-satu, opsional | `item_brands` |
| `items` | satu-ke-banyak | `item_units` |

### Siapa Boleh Apa (`items`)

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar barang | Semua user yang sudah login |
| Menambah/mengubah barang | Role `admin` |
| Menghapus barang secara permanen | Lewat RPC `delete_item()` saja, dan hanya berhasil kalau barang belum pernah dipakai transaksi — kalau sudah, otomatis diarsipkan |

## Kategori & Brand Barang

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `item_categories` | Katalog kategori barang (mis. "Alat Makan", "Perlengkapan Dapur") | `items.category_id` |
| `item_brands` | Katalog merek/brand barang (mis. "Lion Star", "Maspion") | `items.brand_id` |

Katalog terkontrol (pilih dari daftar tetap), bukan teks bebas — mencegah variasi penulisan ("Lion Star" vs "lion star") yang bikin filter/pengelompokan meleset. Pola ini sama seperti katalog kategori biaya tambahan yang sudah ada duluan di modul AR/AP/POS. Kategori dan brand sengaja jadi 2 tabel independen (bukan 1 tabel serba-guna dengan kolom "tipe") karena konsepnya memang beda, dan 1 barang cuma boleh punya 1 kategori & 1 brand (bukan sistem tagging multi-kategori) — cukup untuk kebutuhan pengelompokan simpel yang ada sekarang.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tambah/ubah/nonaktifkan kategori atau brand | — (CRUD langsung ke tabel, gak ada RPC) | Insert/update baris; nonaktifkan pakai `archived_at`, bukan hapus | RLS: `insert`/`update` khusus role `admin` |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kategori/brand yang dinonaktifkan gak mempengaruhi barang yang sudah pernah dikaitkan ke situ | `archived_at` cuma menyembunyikan dari pilihan baru — FK di `items` tetap utuh, nilai lama tetap tampil (snapshot) |
| Barang gak wajib punya kategori/brand | Kolom `items.category_id`/`brand_id` nullable, tanpa backfill paksa ke data lama |
| Murni metadata deskriptif, gak boleh menyentuh perhitungan stok/HPP/jurnal | Tidak ada RPC transaksi apa pun yang membaca kedua kolom ini |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `items.category_id` | banyak-ke-satu, nullable | `item_categories` |
| `items.brand_id` | banyak-ke-satu, nullable | `item_brands` |

### Siapa Boleh Apa (Kategori & Brand)

| Aksi | Siapa boleh |
|---|---|
| Melihat katalog kategori/brand | Semua user yang sudah login |
| Menambah/mengubah kategori/brand | Role `admin` saja |
| Menghapus kategori/brand secara permanen | **Tidak ada seorang pun** — nonaktifkan lewat `archived_at` |

## Satuan Jual & Harga (Multi Unit of Measure)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `item_units` | Satuan jual per barang (boleh lebih dari 1), tiap baris punya faktor konversi & harga sendiri | `items` |

Barang bisa dijual ke customer dalam satuan yang beda dari satuan dasarnya — misal satuan dasar "pcs" (buat pelacakan stok), tapi bisa dijual per pcs atau per lusin (isi 12), masing-masing dengan harga sendiri. Satuan dasar sendiri juga direpresentasikan sebagai 1 baris `item_units` (`is_base = true`, faktor konversi 1) — jadi barang yang cuma dijual dalam 1 satuan cukup 1 baris data.

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `conversion_factor` | Berapa satuan dasar = 1 satuan jual ini | Baris satuan dasar wajib bernilai 1; antar satuan dalam 1 barang harus kelipatan bulat rapi (mis. pcs=1, pack=12, box=144 — bukan box=100), dijaga sistem otomatis biar tampilan stok gabungan ("1 box, 2 pack, 4 pcs") selalu presisi |
| `price` | Harga jual per satuan ini | Nullable, independen — bukan hasil kali otomatis dari harga satuan dasar (harga per lusin boleh didiskon grosir, gak wajib proporsional) |
| `is_base` | Penanda satuan dasar | Maksimal 1 baris `is_base = true` per barang |
| `barcode` | Kode scan (lihat submodule di bawah) | Opsional, unik lintas seluruh `item_units` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tambah/ubah/hapus satuan jual | — (CRUD langsung ke tabel, gak ada RPC) | Insert/update/delete baris `item_units` | RLS: `admin`; trigger `check_item_units_nested_conversion` menolak kombinasi faktor konversi yang gak nested rapi antar satuan barang yang sama, dengan row lock ke baris sibling biar aman dari race condition 2 transaksi bersamaan |
| Konversi qty satuan jual → satuan dasar | — (murni logic UI, terjadi sebelum RPC dipanggil) | Qty yang sampai ke RPC transaksi (order, terima barang, jual barang, produksi, stock opname) selalu sudah dalam satuan dasar | Tidak ada perubahan di RPC transaksi manapun — konversi 100% terjadi di layer UI |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Tiap barang maksimal 1 satuan dasar (faktor konversi wajib 1) | Check constraint `(is_base and conversion_factor = 1) or not is_base` + partial unique index `item_units_one_base_per_item` |
| Qty yang benar-benar dikonsumsi/ditambah ke stok selalu di satuan dasar | Semua RPC transaksi tetap menerima parameter qty di satuan dasar — konversi terjadi di UI sebelum RPC dipanggil, bukan server-side |
| Faktor konversi antar satuan 1 barang harus kelipatan bulat rapi dari satuan di bawahnya | Trigger `check_item_units_nested_conversion` (`before insert or update of conversion_factor`), termasuk backfill check sekali jalan waktu fitur ini pertama ditambahkan yang menolak migration kalau data existing sudah gak nested |
| Harga tiap satuan independen, gak wajib proporsional ke harga satuan dasar | Kolom `price` diisi manual per baris, gak ada formula turunan otomatis |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `item_units.item_id` | banyak-ke-satu | `items` |

### Siapa Boleh Apa (Satuan Jual & Harga)

| Aksi | Siapa boleh |
|---|---|
| Melihat satuan jual barang | Semua user yang sudah login |
| Menambah/mengubah/menghapus satuan jual | Role `admin` |

## Kode Scan Barang (Barcode/QR per Satuan Jual)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `item_units.barcode` (kolom) | Kode identitas scan per satuan jual | Tidak ada tabel baru — nempel ke sebagian baris `item_units` yang dipilih untuk digenerate |

Kode scan ditaruh di level satuan jual (`item_units`), bukan di level barang (`items`), karena kemasan fisik beda (dus/pack/pcs) biasanya punya label/barcode berbeda-beda di dunia nyata — kalau ditaruh di level barang, scan gak bisa langsung tahu satuan mana yang sedang dipegang kasir.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Simpan barcode pabrik | — (update langsung kolom `barcode`) | Kode dari label EAN-13/UPC produsen disimpan apa adanya | Constraint unik global lintas seluruh `item_units` |
| Generate kode internal | `generate_item_unit_barcode(p_unit_id)` (1 transaksi atomik) | Di dalamnya panggil `generate_document_number('item_unit_barcodes')` (reuse, lihat `document-numbering-schema.md`) lalu langsung `update item_units set barcode = ...` pada baris yang sama — kalau ternyata kode itu sudah kepake baris lain (`unique_violation`, mis. barcode lama yang diketik manual saat seed/testing bukan lewat RPC ini), loop otomatis coba nomor berikutnya (maks 20x) tanpa error ke user | Role `admin` (dicek manual dalam fungsi, `security definer` sehingga bypass RLS) + `doc_type = 'item_unit_barcodes'` — pengecualian dari konvensi "doc_type = nama tabel transaksional", karena tidak ada tabel `item_unit_barcodes` sungguhan |
| Cetak label QR | — (murni fitur UI, client-side) | Render QR dari nilai `barcode` yang tersimpan | Tidak ada tabel/kolom penyimpanan gambar |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kode scan harus unik lintas SELURUH satuan jual, gak boleh 2 barang/satuan beda punya kode sama | Constraint `unique` pada kolom `item_units.barcode` (global, bukan scoped per barang) |
| Kode scan gak wajib diisi, dan gak ada aturan "kalau 1 satuan punya kode semua satuan harus punya" | Kolom nullable, independen per baris |
| Gak ada validasi format ketat (bukan EAN-13/UPC checksum) | Kolom menerima teks apa saja — mendukung kode QR generate-sendiri yang gak wajib ikut standar retail resmi |
| Mengubah/menghapus kode gak berdampak retroaktif ke transaksi lama | Transaksi menyimpan qty & harga hasil resolusinya sendiri, tidak balik menunjuk ke kode barcode |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `item_units.barcode` | kolom pada baris yang sama, dipakai saat lookup scan | `item_units` itu sendiri |

### Siapa Boleh Apa (Kode Scan Barang)

| Aksi | Siapa boleh |
|---|---|
| Melihat/scan kode barang | Semua user yang sudah login |
| Mengisi/generate/mengubah kode scan | Role `admin` (sama seperti hak akses `item_units` secara umum) |
