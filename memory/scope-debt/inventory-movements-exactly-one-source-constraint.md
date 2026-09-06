# Constraint "Exactly One Source" `inventory_movements` Belum Dipulihkan

**Modul asal:** Inventory Ledger, ketauan pas unifikasi Retur (`return_lines`, migration `0075`). **Status:** Ditunda.

## Kasus

`inventory_movements` didesain punya tepat 1 dari N kolom polymorphic (`goods_receipt_line_id`, `return_line_id`, dst) yang boleh terisi per baris, ditegakkan lewat `check (num_nonnulls(...) = 1)` (`0042`, diupdate `0046`). Migration `0068` (`drop_purchase_writeoffs`) nge-drop kolom `purchase_writeoff_line_id` — Postgres otomatis nyabut SELURUH check constraint gabungan itu (bukan cuma nguranginnya), dan `0068` gak pernah nambahin constraint pengganti. Sejak itu **gak ada constraint apa pun** yang menegakkan "tepat 1 sumber terisi" di `inventory_movements` — gap dorman yang gak ketauan sampai migration `0075` nyoba merge `inventory_return_line_id`+`purchase_return_line_id` jadi `return_line_id` dan sekalian mau restore constraint-nya.

Waktu dicoba restore, ketauan ada 2 baris live di production yang melanggar (`num_nonnulls = 0`, semua kolom source kosong):
- `inventory_movements.id = c62256be-02d3-460b-81f6-06a92d5d9fdd` — item "Ember Plastik 10L", qty -10, movement_date 2026-08-21.
- `inventory_movements.id = 1b49b7e7-781d-4f32-a071-f255ae20bc1f` — item sama, qty -2, movement_date 2026-08-17.

Kedua baris `created_at` PERSIS sama (2026-08-17 13:00:56+00) dan **gak ada `journal_entries` apa pun** di sekitar waktu itu — semua RPC resmi selalu bikin jurnal barengan pergerakan stok, jadi ini kemungkinan besar insert manual langsung ke database (data fix/seed di luar aplikasi), bukan bug di salah satu RPC.

## Kenapa ditunda

Restore constraint butuh keputusan bisnis dulu soal 2 baris ini, bukan keputusan teknis semata:
- Dikaitkan ke `stock_opname` retroaktif (bikin baris `stock_opname`/`stock_opname_lines` susulan yang match qty & tanggalnya)?
- Dihapus (kalau ternyata data uji coba/salah input yang gak relevan)?
- Dibiarkan permanen dan constraint-nya dikecualikan buat 2 baris ini secara eksplisit (partial check via kondisi tambahan)?

Migration `0075` sengaja TIDAK menunggu keputusan ini — scope-nya udah cukup besar (rename `credit_notes`→`returns` + merge `return_lines` + hapus klasifikasi `condition`), dan constraint ini di luar permintaan awal (ditemukan "sambil lewat" pas migration itu, bukan tujuan utamanya).

## Kapan perlu digarap

Setelah pemilik data mengonfirmasi asal-usul 2 baris "Ember Plastik 10L" di atas dan cara penyelesaiannya. Begitu keputusan diambil, constraint final (9 kolom pasca-`0075`: `goods_receipt_line_id`, `production_order_id`, `return_line_id`, `stock_opname_line_id`, `goods_issue_line_id`, `pos_sale_line_id`, `production_order_line_id`, `warranty_replacement_line_id`, `purchase_replacement_line_id`) bisa ditambahkan lewat migration terpisah:

```sql
alter table inventory_movements add constraint inventory_movements_exactly_one_source check (
  num_nonnulls(
    goods_receipt_line_id, production_order_id, return_line_id,
    stock_opname_line_id, goods_issue_line_id, pos_sale_line_id,
    production_order_line_id, warranty_replacement_line_id, purchase_replacement_line_id
  ) = 1
);
```

## Referensi

- `memory/architecture/data/inventory-ledger-schema.md` — DDL asli `inventory_movements` + daftar kolom polymorphic.
- `supabase/migrations/0042_inventory_movements_schema.sql` — constraint asli (10 kolom).
- `supabase/migrations/0046_inventory_movements_purchase_return_replacement.sql` — constraint diupdate (11 kolom).
- `supabase/migrations/0068_drop_purchase_writeoffs.sql` — titik constraint hilang (drop column tanpa restore).
- `supabase/migrations/0075_rename_returns_and_merge_return_lines.sql` — titik gap ini ketauan.
