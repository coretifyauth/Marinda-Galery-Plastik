# Bundle Promo Rules ("Beli N Gratis X") — Struktur Data

Konsep bisnisnya ada di `docs/domain/accounts-receivable.md` submodule "Beli N Gratis X (Bundle
Promo)". File ini fokus ke struktur datanya. Detail teknis (SQL persis) ada di
`supabase/migrations/0046_bundle_promo_rules_schema.sql`.

`bundle_promo_rules` beda dari `item-discount-rules-schema.md` — berbasis **kuantitas**, bukan
harga. Barang hadiah (`reward_item_id`) boleh beda dari barang pemicu (`trigger_item_id`).

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `bundle_promo_rules` | Master aturan "beli N barang pemicu gratis X barang hadiah" | `items-schema.md` (`trigger_item_id`, `reward_item_id`) |

## Konsep Inti

**Struktur `bundle_promo_rules`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `name` | Nama promo (buat admin) | |
| `trigger_item_id` | Barang yang harus dibeli | Wajib barang spesifik — sengaja gak ada opsi kategori (beda dari `item_discount_rules`), biar gak ada ambiguitas penjumlahan qty lintas barang beda dalam 1 kategori |
| `buy_qty` | Qty minimal beli (N) | > 0 |
| `reward_item_id` | Barang hadiah | Wajib barang spesifik, boleh sama dengan `trigger_item_id` |
| `free_qty` | Qty gratis per kelipatan (X) | > 0 |
| `archived_at` | Soft-delete | Aktif terus sampai diarsipkan manual, sama pola `item_discount_rules` |

**Keunikan**: partial unique index di `(trigger_item_id, reward_item_id)` — cuma cegah 2 aturan aktif dengan kombinasi pemicu+hadiah yang SAMA. **Sengaja membolehkan** beberapa aturan aktif dengan `trigger_item_id` sama (asal `reward_item_id` beda) MAUPUN beberapa aturan aktif dengan `reward_item_id` sama (asal `trigger_item_id` beda) — beda dari `item_discount_rules` yang dibatasi 1 aturan aktif per item.

**Alur Teknis (RPC)**

| Aksi | RPC/Fungsi | Efek | Guard |
|---|---|---|---|
| Resolusi diskon item/kategori server-side | `resolve_item_discount(item_id, qty, amount)` | Mirror `resolveItemDiscount()` TypeScript (`item-discount-rules-schema.md`) — item menang atas kategori, return 0/1 baris | Dipakai `create_pos_sale` doang — sisi admin (`create_order`/`create_goods_issue`) tetap trust hasil TypeScript dari client |
| Resolusi bundle promo server-side | `resolve_bundle_promo_discounts(p_lines)` | Jumlahkan `qty_sold` per `item_id` lintas SEMUA baris dulu (basis trigger qty), baru per baris cek apakah baris itu `reward_item_id` dari aturan aktif — `floor(trigger_qty/buy_qty)*free_qty`, diakumulasi kalau >1 aturan match reward yang sama, dibatasi qty baris itu sendiri. Return array sejajar `p_lines` | TIDAK PERNAH menambah baris baru — kalau `reward_item_id` gak ada di `p_lines`, gak ada efek apa pun |
| Checkout kasir (POS) | `create_pos_sale` | Panggil kedua fungsi di atas per baris/sekali di awal, gabung diskon dari kedua mekanisme (dibatasi gak lebih dari nilai gross baris), baru teruskan ke `create_goods_issue` — **beda dari sisi admin**, resolusi di sini WAJIB server-side karena RPC ini `security definer` dipakai role `cashier` yang gak dipercaya | HPP tetap dari `consume_weighted_average` (cost barang keluar), TIDAK kepengaruh diskon harga jual sama sekali |
| Sales Order / Jual Barang Langsung (admin) | `create_order` / `create_goods_issue` | `p_lines` boleh bawa `bundle_promo_rule_id` opsional per baris (hasil resolusi TypeScript cart-wide di client, sama pola `discount_rule_id`) — murni disimpan buat audit trail, gak dipakai aritmatika RPC | Signature RPC TIDAK berubah dari `item-discount-rules-schema.md` |

**Kenapa titik komputasinya beda dari `item_discount_rules`**: sisi admin (Sales Order/Goods Issue) RPC-nya `security invoker`, dipakai role admin/accountant yang udah lebih dipercaya, dan udah dari awal gak pernah menghitung ulang harga dari master data (lihat rasionalnya di `item-discount-rules-schema.md`). Checkout kasir (`create_pos_sale`) beda — `security definer`, dipakai role `cashier` yang aksesnya sengaja dibatasi, dan RPC ini SUDAH dari awal (sebelum ada fitur diskon) menghitung `v_total_amount` sendiri dari `qty_sold*unit_price` tanpa percaya client — jadi resolusi diskon ngikut pola trust yang SAMA, bukan bikin pengecualian baru.

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `bundle_promo_rules.trigger_item_id` | banyak-ke-satu | `items` |
| `bundle_promo_rules.reward_item_id` | banyak-ke-satu | `items` |
| `order_lines.bundle_promo_rule_id` | banyak-ke-satu, opsional | `bundle_promo_rules` (lihat `orders-schema.md`) |
| `goods_note_lines.bundle_promo_rule_id` | banyak-ke-satu, opsional | `bundle_promo_rules` (lihat `goods-notes-schema.md`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar aturan bundle promo | Semua user yang sudah login |
| Menambah/mengarsipkan/mengubah aturan | Role `admin` |
