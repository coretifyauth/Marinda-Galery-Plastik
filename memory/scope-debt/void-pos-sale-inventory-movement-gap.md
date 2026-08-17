# `void_pos_sale` Gak Nyatet Kompensasi ke Kartu Stok

**Modul asal:** Inventory / POS (Kartu Stok — Inventory Movement Ledger). **Status:** Ditunda.

## Kasus

RPC `void_pos_sale` (pembatalan transaksi POS, `security invoker`, definisi live di `supabase/migrations/0015_readable_error_messages.sql` baris ~1552-1595, awalnya `0009_pos_schema.sql`) mengembalikan `qty_on_hand` di `inventory_balances` langsung lewat `UPDATE` (nambah balik qty yang tadi dikurangi `create_pos_sale`), tapi **gak pernah insert baris kompensasi ke `inventory_movements`** (tabel ledger baru, migration `0042`-`0051`, submodule "Kartu Stok / Riwayat Mutasi per Item" di `memory/architecture/data/inventory-schema.md` + `memory/domain/inventory.md`).

Akibatnya: kalau ada kasir yang void transaksi POS, `inventory_balances.qty_on_hand` bakal **benar** (pulih ke angka sebelum transaksi), tapi Kartu Stok item itu bakal **tetap nunjukin barang "keluar"** untuk transaksi yang sebenarnya udah dibatalkan — drift permanen antara saldo real-time (benar) dan riwayat mutasi (salah), gak kedeteksi otomatis sampai ada yang jalanin rekonsiliasi manual lagi.

**Ditemukan:** 2026-08-17, ketauan lewat `schema-reviewer` pas review migration `0051` (backfill data historis `inventory_movements`) — ditelusuri sebagai "skenario data live realistis yang bisa bikin rekonsiliasi backfill gagal". Dicek lewat `npx supabase db query --linked` ke database live: **belum ada riwayat void POS sale sama sekali** di data historis project ini —

```sql
select ps.id from pos_sales ps
join journal_entries je on je.reverses_entry_id = ps.revenue_journal_entry_id;
-- hasil: kosong
```

Karena itu migration `0051` (backfill + rekonsiliasi `SUM(inventory_movements.qty)` vs `inventory_balances.qty_on_hand` per item) berhasil diapply tanpa gagal — tapi bug di `void_pos_sale` sendiri tetap ada dan belum diperbaiki.

## Kenapa ditunda

User memilih apply migration `0051` (backfill) dulu (aman, gak ada void historis yang kena dampak), dan menunda perbaikan `void_pos_sale` ke sesi terpisah — bukan urgent karena belum pernah ada kejadian nyata yang kena dampak, tapi **wajib diperbaiki sebelum kejadian void pertama** supaya gak nimbulin drift permanen yang baru.

Pola perbaikan yang sudah dipikirkan (belum dikerjakan): mirror pola yang sudah dipakai buat gap serupa di `purchase_replacement_lines` (migration `0046`, ditemukan & ditutup duluan dalam rangkaian yang sama) — `void_pos_sale` perlu `CREATE OR REPLACE` (signature tetap sama) ditambah insert baris `inventory_movements` per item yang di-void, `qty` **positif** (kompensasi/pemulihan), nunjuk ke `pos_sale_line_id` yang SAMA dengan baris movement OUT asli dari `create_pos_sale`. Ini sah karena CHECK `num_nonnulls(...)=1` di `inventory_movements` dicek per baris ledger, bukan per baris sumber — jadi 1 `pos_sale_line_id` boleh ditunjuk lebih dari 1 baris ledger (persis pola `purchase_replacement_line_id` yang sekarang dipunya 2 baris: 1 OUT + 1 IN).

Gak dikerjakan sekalian di sesi ini karena rangkaian 8 RPC yang disepakati di awal (`create_purchase_writeoff`, `create_warranty_replacement`, `record_stock_opname`, `create_ap_credit_note`+`create_purchase_replacement`, `create_ar_credit_note`, `create_goods_receipt`, `create_production_order`, `create_goods_issue`+`create_pos_sale`) udah selesai semua — `void_pos_sale` itu RPC ke-9 yang gak kelewat masuk daftar asli, ditemukan belakangan lewat proses review, jadi diputuskan jadi item tersendiri biar gak molorin fitur inti yang udah kelar.

## Referensi

- `memory/architecture/data/inventory-schema.md` submodule "Kartu Stok / Riwayat Mutasi per Item" (desain lengkap `inventory_movements`, termasuk gap `purchase_replacement_lines` yang sudah ditutup `0046` sebagai preseden pola perbaikan)
- `memory/domain/inventory.md` submodule "Kartu Stok / Riwayat Mutasi per Item"
- `supabase/migrations/0009_pos_schema.sql` (definisi awal `void_pos_sale` + `create_pos_sale`)
- `supabase/migrations/0015_readable_error_messages.sql` (definisi live terkini `void_pos_sale`)
- `supabase/migrations/0046_inventory_movements_purchase_return_replacement.sql` (preseden pola "1 baris sumber = banyak baris ledger")
