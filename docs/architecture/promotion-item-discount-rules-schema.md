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
| `min_qty` | Syarat minimal qty sebagaimana diketik admin | Nullable. `NULL` = tanpa syarat (perilaku lama, aturan lama tetap jalan). **Cuma aturan level barang** — satuan seperti "dos" milik tiap barang, jadi di kategori maknanya ambigu (CHECK `category_id is null or min_qty is null`) |
| `min_qty_unit_id` | Satuan jual (milik `item_id` yang sama) yang dipakai admin menulis syarat | FK ke `item_units`; berpasangan dengan `min_qty` (CHECK) |
| `min_qty_base` | `min_qty × conversion_factor` satuan itu | **Diisi trigger** (bukan input) — inilah nilai yang dibandingkan resolver ke total qty satuan dasar barang itu lintas semua baris |
| `archived_at` | Tanggal arsip | Soft-delete, pola sama `items`/`charge_categories` — gak ada tanggal mulai/berakhir (periode promo sengaja belum ada), aktif terus sampai diarsipkan manual |

**Aturan mutual exclusivity & keunikan**
- Tepat satu dari `item_id`/`category_id` wajib keisi (`num_nonnulls(item_id, category_id) = 1`).
- Maksimal 1 aturan **aktif** (belum diarsipkan) per `category_id` (partial unique index). Untuk `item_id`: maksimal 1 aturan aktif per **(barang, nilai syarat minimal)** — partial unique index `promotion_item_discount_rules_one_active_per_item_tier` pada `(item_id, coalesce(min_qty_base, 0))`. Jadi 1 aturan "tanpa syarat" + beberapa aturan bertingkat dengan syarat beda boleh aktif bareng, tapi 2 aturan dengan syarat SAMA (juga kalau ditulis di satuan beda, mis. 12.500 pcs vs 10 dos) ditolak.
- **Pemilihan aturan (bertingkat)**: dari aturan barang aktif yang `min_qty_base <= total qty satuan dasar barang itu` (lintas SEMUA baris transaksi; NULL dianggap 0), dipakai SATU dengan `min_qty_base` tertinggi — gak ditumpuk. Begitu terpilih, diskon dihitung ke qty/amount **tiap baris** barang itu (seluruh qty, bukan cuma kelebihan di atas syarat). Kalau gak ada aturan barang yang terpenuhi, jatuh ke aturan kategori penaungnya (selalu tanpa syarat). Resolusi ini dilakukan di lapisan aplikasi (TypeScript) untuk jalur admin dan di `resolve_item_discount` (SQL) untuk POS — bukan constraint database, karena soal urutan prioritas baca, bukan keunikan data.
- Satuan di `min_qty_unit_id` wajib milik `item_id` aturan itu (dicek trigger). Faktor konversi satuan yang dirujuk aturan promo **gak boleh diubah** (trigger `item_units_guard_promo_conversion_factor`, juga memindah satuan ke barang lain) — `min_qty_base` sudah dihitung dari faktor lama dan gak ikut berubah otomatis; satuan yang dipakai promo juga gak bisa dihapus (FK).

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Cari/pakai aturan diskon aktif buat 1 barang | — (query langsung dari TypeScript, sama pola `item_units`/`charge_categories`) | Sistem otomatis cocokkan berdasar `item_id` barang itu (aturan yang syaratnya terpenuhi, tingkat tertinggi), fallback ke `category_id` kategorinya — staf gak pernah pilih manual. Form admin memakai `resolveLineItemDiscounts()` (cart-wide, diturunkan tiap render karena diskon 1 baris bergantung baris lain) | — |
| Hitung `min_qty_base` | — (trigger `promotion_item_discount_rules_fill_min_qty_base` pada insert/update apa pun) | `min_qty × conversion_factor` satuan `min_qty_unit_id`; menolak satuan yang bukan milik barang aturan | CHECK `min_qty_complete` menolak setengah isi (qty tanpa satuan atau sebaliknya) |
| Resolusi server-side (POS) | `resolve_item_discount(item_id, qty, amount, total_qty)` — `total_qty` = total qty satuan dasar barang lintas semua baris (NULL → `qty` baris itu sendiri) | Syarat dicek ke `total_qty`, diskon dihitung ke `qty`/`amount` baris. `create_pos_sale` menghitung total per barang dulu | Dipakai `create_pos_sale` doang — sisi admin tetap trust hasil TypeScript |
| Sales Order dikirim bertahap (Fulfill) | — (TypeScript) | Syarat dicek ke **total qty yang DIPESAN di SO** (semua baris SO barang itu), diskon dihitung ke qty yang dikirim — SO 12 dos dikirim 6+6 tetap kena diskon "≥10 dos" di kedua pengiriman, gak bisa diakali dengan memecah pengiriman. Jalur lain (Sales Order baru, Goods Issue langsung, POS) mengecek ke total di transaksi itu sendiri | Diskon di `order_lines` cuma estimasi, dihitung ulang saat realisasi |
| Kelola aturan (tambah/arsipkan) | — (insert/update langsung ke tabel) | Aturan baru langsung ikut dicocokkan transaksi berikutnya | RLS: cuma role `admin` yang boleh insert/update |

**Kenapa resolusi dilakukan di TypeScript, bukan di dalam RPC `create_order`/`create_goods_issue`**: kedua RPC itu sudah gak pernah menghitung ulang harga dari master data (`p_credit_lines`/`p_lines` yang dikirim ke `create_goods_issue` sudah final dari client, mengikuti pola `item_units.price` yang juga sudah lebih dulu dihitung client-side) — menambah "pengecualian" baru khusus diskon di dalam RPC bakal memecah satu-satunya sumber kebenaran harga yang sudah konsisten sekarang. `discount_rule_id`/`discount_amount` yang tersimpan di `order_lines`/`goods_note_lines` (lihat `orders-schema.md`/`goods-notes-schema.md`) murni audit trail hasil resolusi itu, bukan input yang dipakai ulang buat menghitung.

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `promotion_item_discount_rules.item_id` | banyak-ke-satu, opsional | `items` |
| `promotion_item_discount_rules.category_id` | banyak-ke-satu, opsional | `item_categories` |
| `promotion_item_discount_rules.min_qty_unit_id` | banyak-ke-satu, opsional (cuma aturan barang) | `item_units` (satuan syarat minimal; milik `item_id` yang sama) |
| `order_lines.discount_rule_id` | banyak-ke-satu, opsional | `promotion_item_discount_rules` (lihat `orders-schema.md`) |
| `goods_note_lines.discount_rule_id` | banyak-ke-satu, opsional | `promotion_item_discount_rules` (lihat `goods-notes-schema.md`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar aturan diskon | Semua user yang sudah login |
| Menambah/mengarsipkan aturan diskon | Role `admin` |
| Mengubah isi aturan (nilai/target) setelah dibuat | Role `admin` (update diperbolehkan — beda dari tabel transaksional yang immutable, ini master data) |
