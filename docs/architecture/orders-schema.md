# Order (Purchase Order & Sales Order) — Struktur Data

Konsep bisnisnya (kenapa order cuma "komitmen" dan belum bikin jurnal, kenapa opsional, aturan pembatalan) ada di `docs/domain/inventory.md` bagian "Purchase Order & Sales Order (Order) & Penerimaan Barang (3-Way Matching)". File ini fokus ke struktur datanya. Detail teknis (SQL, nama fungsi persis) ada di `supabase/migrations/0014_orders_schema.sql`.

`orders` + `order_lines` menyimpan baik Purchase Order maupun Sales Order dalam 1 spine, dibedakan cuma dari kolom `direction` (`PURCHASE`/`SALE`). Keduanya struktur & aturannya kembar (sama-sama komitmen, sama-sama opsional, sama-sama batal sebelum ada realisasi fisik) — konsisten dengan pemasok/customer yang juga 1 konsep "pihak" (lihat `counterparty-schema.md`). Realisasi fisiknya sendiri sekarang tersimpan di 1 tabel generic, `goods-notes-schema.md` (`goods_notes`, dibedakan `type` `INBOUND`/`OUTBOUND`) — tapi **alurnya (RPC)** tetap 2 beda: `create_goods_receipt` (sisi beli) dan `create_goods_issue` (sisi jual), karena efek jurnalnya beda total.

> **Migration final (2026-09-07):** `supabase/migrations/0014_orders_schema.sql` -- konsolidasi dari migration incremental lama (0001-0084, sudah dihapus). Nomor migration `00XX` yang disebut di seluruh dokumen ini HISTORIS (isinya tetap akurat sebagai catatan evolusi keputusan, lihat `git log` kalau perlu baca file aslinya) -- SQL final yang AKTIF di database sekarang ada di file yang disebut di atas.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `orders` | Header komitmen pesan — ke supplier (`direction='PURCHASE'`) atau dari customer (`direction='SALE'`) | `counterparty-schema.md` (`counterparty_id`) |
| `order_lines` | Baris item yang dipesan (item, qty dipesan, harga sepakat) | `orders`, `items-schema.md` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `orders` | 1 baris = 1 komitmen pesan (PO atau SO, dibedakan `direction`) | `counterparties` |
| `order_lines` | 1 baris = 1 item yang dipesan dalam 1 order | `orders`, `items` |

**Struktur `orders` (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `direction` | `PURCHASE` atau `SALE` | Menentukan role pihak yang wajib (supplier/customer), menentukan RPC realisasi mana yang boleh dipakai |
| `counterparty_id` | Pihak yang dipesan (supplier) atau yang memesan (customer) | Dicek role-nya sesuai `direction` — gak bisa asal pilih pihak |
| `order_date`, `expected_date`, `source_ref` | Tanggal order, estimasi tanggal barang datang/dikirim, nomor referensi dokumen | — |
| `status` | `OPEN` / `PARTIALLY_RECEIVED`|`PARTIALLY_FULFILLED` / `FULLY_RECEIVED`|`FULLY_FULFILLED` / `CANCELLED` | Nama status tergantung `direction` (istilah "terima" buat beli, "penuhi" buat jual); dihitung ulang otomatis tiap ada realisasi baru |
| `cancelled_at` | Tanggal dibatalkan (kosong kalau belum) | Sekali keisi, order itu beku total — gak bisa diapa-apain lagi |

**Struktur `order_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `item_id`, `qty_ordered`, `unit_price` | Barang, jumlah dipesan, harga sepakat | Harga di sini cuma "kesepakatan awal" — harga/qty riil dicatat ulang saat realisasi (GRN/Goods Issue), boleh beda |
| `discount_rule_id`, `discount_amount` | Estimasi diskon (cuma buat `direction='SALE'`) | Resolusi otomatis dari `item-discount-rules-schema.md` saat order dibuat, `qty_ordered` penuh — PURELY informational (order gak pernah bikin jurnal). Dihitung ULANG dari nol saat realisasi ke `goods_note_lines`, bukan diwarisi dari sini — qty riil & aturan yang aktif saat realisasi boleh beda. Selalu `NULL`/`0` buat `direction='PURCHASE'` (sisi beli gak pakai aturan) |
| `bundle_promo_rule_id` | Estimasi "Beli N Gratis X" (cuma buat `direction='SALE'`) | Resolusi cart-wide dari `bundle-promo-rules-schema.md` — sama sifatnya kayak `discount_rule_id` (informational, dihitung ulang saat realisasi) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat order baru (PO atau SO) | `create_order` | Insert 1 header `orders` + baris-baris `order_lines` sekaligus. **Gak bikin jurnal apa pun** — order murni rencana | Cuma terima `direction` `PURCHASE`/`SALE`; pihak yang dipilih harus terdaftar dengan role yang sesuai (`supplier` buat beli, `customer` buat jual) |
| Batalkan order | `cancel_order` | Set `status='CANCELLED'` + `cancelled_at` terisi. **Gak ada jurnal pembalik** (order emang gak pernah punya jurnal) | Ditolak kalau udah ada realisasi fisik apa pun terhadap order itu (minimal 1 GRN buat PO, minimal 1 Goods Issue buat SO) |
| Terima barang / kirim barang atas order ini | `create_goods_receipt` / `create_goods_issue` | Update status order otomatis (dihitung ulang tiap ada baris realisasi baru) | Lihat `goods-notes-schema.md` |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Order bukan kejadian akuntansi — gak ada jurnal sampai barang beneran berpindah | `create_order` murni insert, gak memanggil fungsi jurnal apa pun |
| Order tidak wajib buat kedua arah — bisa dilewati buat transaksi dadakan/spontan | `order_id` di GRN dan `order_id` (via `order_line_id`) di Goods Issue sama-sama nullable |
| Pihak di order harus sesuai perannya (supplier buat PO, customer buat SO) | Trigger yang mengecek pihak terdaftar dengan role yang cocok terhadap `direction`, dijalankan tiap insert order baru |
| Order boleh dibatalkan hanya kalau belum ada realisasi fisik sama sekali | Guard di `cancel_order` — cek dulu ada/tidaknya baris realisasi (GRN/Goods Issue) yang menunjuk order itu sebelum mengizinkan pembatalan |
| Order yang sudah dibatalkan gak bisa dipakai dasar transaksi baru | Guard di `create_goods_receipt`/`create_goods_issue` — menolak kalau order tujuan sudah `cancelled_at` |
| Sekali order dibuat, datanya gak bisa diubah diam-diam (cuma status/pembatalan yang boleh berubah) | Trigger immutability pada `orders` (bandingkan semua kolom selain status/pembatalan) + `order_lines` full-immutable |
| Order gak pernah bisa dihapus | Trigger yang menolak `DELETE` pada `orders` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `orders.counterparty_id` | banyak-ke-satu | `counterparties` |
| `order_lines.order_id` | banyak-ke-satu | `orders` |
| `order_lines.item_id` | banyak-ke-satu | `items` |
| `order_lines.discount_rule_id` | banyak-ke-satu, opsional | `item_discount_rules` (`item-discount-rules-schema.md`), cuma keisi buat `direction='SALE'` |
| `order_lines.bundle_promo_rule_id` | banyak-ke-satu, opsional | `bundle_promo_rules` (`bundle-promo-rules-schema.md`), cuma keisi buat `direction='SALE'` |
| `order_lines` (via `order_line_id`) | satu-ke-banyak (opsional) | `goods_note_lines` (`goods_notes.type='INBOUND'` kalau `direction='PURCHASE'`, `'OUTBOUND'` kalau `direction='SALE'`) |

Catatan tampilan: di aplikasi, Purchase Order dan Sales Order tetap tampil sebagai 2 halaman/menu terpisah (`/purchase-orders`, `/sales-orders`) — ini keputusan UI yang sengaja dipertahankan, bukan cerminan bahwa datanya masih 2 tabel berbeda.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar order (PO maupun SO) | Semua user yang sudah login |
| Membuat order baru | Role `admin` atau `accountant` |
| Membatalkan order | Role `admin` atau `accountant` (lewat `cancel_order`, tunduk pada guard "belum ada realisasi") |
| Mengubah isi order (item, qty, harga) setelah dibuat | **Tidak ada seorang pun** — order immutable, koreksi harus lewat order baru |
| Menghapus order | **Tidak ada seorang pun** |
