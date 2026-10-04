# Bundle Promo Rules ("Beli N Gratis X") — Struktur Data

Konsep bisnisnya ada di `docs/domain/accounts-receivable.md` submodule "Beli N Gratis X (Bundle
Promo)". File ini fokus ke struktur datanya. Detail teknis (SQL persis) ada di
`supabase/migrations/0046_bundle_promo_rules_schema.sql`.

`promotion_bundle_rules` beda dari `promotion-item-discount-rules-schema.md` — berbasis **kuantitas**, bukan
harga. Barang hadiah (`reward_item_id`) boleh beda dari barang pemicu (`trigger_item_id`).

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `promotion_bundle_rules` | Master aturan "beli N barang pemicu gratis X barang hadiah" | `items-schema.md` (`trigger_item_id`, `reward_item_id`) |

## Konsep Inti

**Struktur `promotion_bundle_rules`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `name` | Nama promo (buat admin) | |
| `trigger_item_id` | Barang yang harus dibeli | Wajib barang spesifik — sengaja gak ada opsi kategori (beda dari `promotion_item_discount_rules`), biar gak ada ambiguitas penjumlahan qty lintas barang beda dalam 1 kategori |
| `buy_qty` | Qty minimal beli (N) | > 0 |
| `reward_item_id` | Barang hadiah | Wajib barang spesifik, boleh sama dengan `trigger_item_id` |
| `free_qty` | Qty gratis per kelipatan (X) | > 0 |
| `buy_unit_id` / `buy_unit_qty` | Satuan & qty beli sebagaimana diketik admin (mis. 10 dos) | Opsional, berpasangan (CHECK). Satuan wajib milik `trigger_item_id`. Kalau terisi, trigger mengisi `buy_qty = buy_unit_qty × conversion_factor` |
| `reward_unit_id` / `reward_unit_qty` | Satuan & qty hadiah sebagaimana diketik admin (mis. 1 dos) | Opsional, berpasangan. Satuan wajib milik `reward_item_id`. Kalau terisi, trigger mengisi `free_qty = reward_unit_qty × conversion_factor` |
| `reward_type` | `FREE` / `PERCENT` / `NOMINAL` | Default `FREE` (perilaku lama: harga baris hadiah jadi Rp0). `PERCENT`/`NOMINAL` = diskon pada qty hadiah yang berhak |
| `reward_value` | Persen (maks 100) atau Rupiah **per satuan dasar** barang hadiah | `NULL` kalau `FREE`; wajib terisi dan > 0 kalau `PERCENT`/`NOMINAL` (CHECK) |
| `archived_at` | Soft-delete | Aktif terus sampai diarsipkan manual, sama pola `promotion_item_discount_rules` — gak ada tanggal mulai/berakhir (periode promo sengaja belum ada) |

`buy_qty` dan `free_qty` tetap **kanonik dalam satuan dasar** — itulah yang dipakai resolver. Kolom satuan/qty-ketikan cuma metadata input admin (tampilan "beli 10 dos"), jadi aturan lama (tanpa satuan) tetap berlaku persis seperti sebelumnya. Faktor konversi satuan yang dirujuk promo gak boleh diubah (trigger `item_units_guard_promo_conversion_factor`) dan satuan itu gak bisa dihapus (FK).

**Keunikan**: partial unique index di `(trigger_item_id, reward_item_id)` — cuma cegah 2 aturan aktif dengan kombinasi pemicu+hadiah yang SAMA. **Sengaja membolehkan** beberapa aturan aktif dengan `trigger_item_id` sama (asal `reward_item_id` beda) MAUPUN beberapa aturan aktif dengan `reward_item_id` sama (asal `trigger_item_id` beda) — beda dari `promotion_item_discount_rules` yang dibatasi 1 aturan aktif per item.

**Alur Teknis (RPC)**

| Aksi | RPC/Fungsi | Efek | Guard |
|---|---|---|---|
| Resolusi diskon item/kategori server-side | `resolve_item_discount(item_id, qty, amount, total_qty)` | Mirror `resolveItemDiscount()` TypeScript (`promotion-item-discount-rules-schema.md`) — aturan barang yang syarat minimalnya terpenuhi menang atas kategori, tingkat tertinggi, return 0/1 baris | Dipakai `create_pos_sale` doang — sisi admin (`create_order`/`create_goods_issue`) tetap trust hasil TypeScript dari client |
| Resolusi bundle promo server-side | `resolve_bundle_promo_discounts(p_lines)` | Jumlahkan `qty_sold` per `item_id` lintas SEMUA baris dulu (basis trigger qty). Tiap aturan punya **pool jatah hadiah** = `floor(trigger_qty/set) * free_qty` (barang sama: set = `buy_qty+free_qty`). Tiap baris barang hadiah mengambil dari pool aturan yang menaunginya berurutan (urut `id`), dibatasi qty baris dan **sisa pool** — barang hadiah di >1 baris (mis. pcs + ikat) gak bisa lagi masing-masing ngeklaim jatah penuh (fix hitung ganda). Diskon per unit: `FREE` = harga, `PERCENT` = harga × nilai/100, `NOMINAL` = min(nilai, harga). Baris berharga 0 dilewati (gak menghabiskan pool). Return array sejajar `p_lines`; `bundle_promo_rule_id` = aturan pertama yang menyumbang diskon baris itu | TIDAK PERNAH menambah baris baru — kalau `reward_item_id` gak ada di `p_lines`, gak ada efek apa pun |
| Hitung `buy_qty`/`free_qty` | — (trigger `promotion_bundle_rules_fill_base_qty` pada insert/update apa pun) | Dari `buy_unit_qty`/`reward_unit_qty` × faktor satuan; menolak satuan yang bukan milik barang pemicu/hadiah | CHECK `reward_value_matches_type` |
| Sales Order dikirim bertahap | — (TypeScript) | Bundle dihitung **per pengiriman** (qty pemicu & hadiah yang dikirim di pengiriman itu), BUKAN dari total SO — jatah hadiah gak dilacak antar pengiriman, jadi basis total SO bakal bikin tiap pengiriman ngeklaim jatah penuh (over-grant). Beda dari syarat minimal diskon barang yang memakai total SO | — |
| Checkout kasir (POS) | `create_pos_sale` | Panggil kedua fungsi di atas per baris/sekali di awal, gabung diskon dari kedua mekanisme (dibatasi gak lebih dari nilai gross baris), baru teruskan ke `create_goods_issue` — **beda dari sisi admin**, resolusi di sini WAJIB server-side karena RPC ini `security definer` dipakai role `cashier` yang gak dipercaya | HPP tetap dari `consume_weighted_average` (cost barang keluar), TIDAK kepengaruh diskon harga jual sama sekali |
| Sales Order / Jual Barang Langsung (admin) | `create_order` / `create_goods_issue` | `p_lines` boleh bawa `bundle_promo_rule_id` opsional per baris (hasil resolusi TypeScript cart-wide di client, sama pola `discount_rule_id`) — murni disimpan buat audit trail, gak dipakai aritmatika RPC | Signature RPC TIDAK berubah dari `promotion-item-discount-rules-schema.md` |

**Kenapa titik komputasinya beda dari `promotion_item_discount_rules`**: sisi admin (Sales Order/Goods Issue) RPC-nya `security invoker`, dipakai role admin/accountant yang udah lebih dipercaya, dan udah dari awal gak pernah menghitung ulang harga dari master data (lihat rasionalnya di `promotion-item-discount-rules-schema.md`). Checkout kasir (`create_pos_sale`) beda — `security definer`, dipakai role `cashier` yang aksesnya sengaja dibatasi, dan RPC ini SUDAH dari awal (sebelum ada fitur diskon) menghitung `v_total_amount` sendiri dari `qty_sold*unit_price` tanpa percaya client — jadi resolusi diskon ngikut pola trust yang SAMA, bukan bikin pengecualian baru.

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `promotion_bundle_rules.trigger_item_id` | banyak-ke-satu | `items` |
| `promotion_bundle_rules.reward_item_id` | banyak-ke-satu | `items` |
| `promotion_bundle_rules.buy_unit_id` | banyak-ke-satu, opsional | `item_units` (satuan milik `trigger_item_id`) |
| `promotion_bundle_rules.reward_unit_id` | banyak-ke-satu, opsional | `item_units` (satuan milik `reward_item_id`) |
| `order_lines.bundle_promo_rule_id` | banyak-ke-satu, opsional | `promotion_bundle_rules` (lihat `orders-schema.md`) |
| `goods_note_lines.bundle_promo_rule_id` | banyak-ke-satu, opsional | `promotion_bundle_rules` (lihat `goods-notes-schema.md`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar aturan bundle promo | Semua user yang sudah login |
| Menambah/mengarsipkan/mengubah aturan | Role `admin` |
