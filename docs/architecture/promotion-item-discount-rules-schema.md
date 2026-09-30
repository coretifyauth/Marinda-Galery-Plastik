# Item Discount Rules — Struktur Data

Konsep bisnisnya ada di `docs/domain/accounts-receivable.md` submodule "Diskon Penjualan (Trade
Discount)" dan `docs/domain/accounts-payable.md` submodule "Diskon Pembelian (Trade Discount)".
File ini fokus ke struktur datanya. Detail teknis (SQL persis) ada di
`supabase/migrations/0045_item_discount_rules_schema.sql`.

`promotion_item_discount_rules` cuma dipakai sisi **penjualan** (OUTBOUND) — sisi pembelian (INBOUND)
sengaja gak pakai master data ini sama sekali, diskonnya nominal manual per dokumen (lihat
submodule "Diskon Pembelian" di `goods-notes-schema.md` bagian `create_goods_receipt`).

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `promotion_item_discount_rules` | Master aturan diskon, ditempelkan ke 1 barang ATAU 1 kategori barang | `items-schema.md` (`item_id`, `category_id`) |

## Konsep Inti

**Struktur `promotion_item_discount_rules`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `name` | Nama aturan (buat admin) | Bebas teks, murni label |
| `item_id` | Barang yang dinaungi aturan ini | Mutual exclusive dengan `category_id` — tepat satu yang keisi |
| `category_id` | Kategori barang yang dinaungi aturan ini | Mutual exclusive dengan `item_id` |
| `discount_type` | `PERCENT` atau `NOMINAL` | |
| `discount_value` | Besaran diskon | `PERCENT`: persentase (maks 100). `NOMINAL`: Rupiah **per unit satuan dasar barang**, bukan per baris/lump sum — biar hasilnya otomatis benar walau qty yang ditransaksikan cuma sebagian dari qty_ordered |
| `archived_at` | Tanggal arsip | Soft-delete, pola sama `items`/`charge_categories` — gak ada tanggal mulai/berakhir, aktif terus sampai diarsipkan manual |

**Aturan mutual exclusivity & keunikan**
- Tepat satu dari `item_id`/`category_id` wajib keisi (`num_nonnulls(item_id, category_id) = 1`).
- Maksimal 1 aturan **aktif** (belum diarsipkan) per `item_id`, dan maksimal 1 aturan aktif per `category_id` — ditegakkan lewat partial unique index, bukan cuma konvensi UI. Ini mencegah 2 aturan aktif bersaing di level yang sama (item-vs-item atau kategori-vs-kategori).
- Kalau 1 barang match ke aturan item DAN aturan kategori penaungnya sekaligus, resolusi "aturan item (lebih spesifik) menang" dilakukan di lapisan aplikasi (TypeScript) saat query — bukan constraint database, karena ini soal urutan prioritas baca, bukan soal keunikan data.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Cari/pakai aturan diskon aktif buat 1 barang | — (query langsung dari TypeScript, sama pola `item_units`/`charge_categories`) | Sistem otomatis cocokkan berdasar `item_id` barang itu, fallback ke `category_id` kategorinya kalau gak ada aturan item — staf gak pernah pilih manual | — |
| Kelola aturan (tambah/arsipkan) | — (insert/update langsung ke tabel) | Aturan baru langsung ikut dicocokkan transaksi berikutnya | RLS: cuma role `admin` yang boleh insert/update |

**Kenapa resolusi dilakukan di TypeScript, bukan di dalam RPC `create_order`/`create_goods_issue`**: kedua RPC itu sudah gak pernah menghitung ulang harga dari master data (`p_credit_lines`/`p_lines` yang dikirim ke `create_goods_issue` sudah final dari client, mengikuti pola `item_units.price` yang juga sudah lebih dulu dihitung client-side) — menambah "pengecualian" baru khusus diskon di dalam RPC bakal memecah satu-satunya sumber kebenaran harga yang sudah konsisten sekarang. `discount_rule_id`/`discount_amount` yang tersimpan di `order_lines`/`goods_note_lines` (lihat `orders-schema.md`/`goods-notes-schema.md`) murni audit trail hasil resolusi itu, bukan input yang dipakai ulang buat menghitung.

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `promotion_item_discount_rules.item_id` | banyak-ke-satu, opsional | `items` |
| `promotion_item_discount_rules.category_id` | banyak-ke-satu, opsional | `item_categories` |
| `order_lines.discount_rule_id` | banyak-ke-satu, opsional | `promotion_item_discount_rules` (lihat `orders-schema.md`) |
| `goods_note_lines.discount_rule_id` | banyak-ke-satu, opsional | `promotion_item_discount_rules` (lihat `goods-notes-schema.md`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar aturan diskon | Semua user yang sudah login |
| Menambah/mengarsipkan aturan diskon | Role `admin` |
| Mengubah isi aturan (nilai/target) setelah dibuat | Role `admin` (update diperbolehkan — beda dari tabel transaksional yang immutable, ini master data) |
