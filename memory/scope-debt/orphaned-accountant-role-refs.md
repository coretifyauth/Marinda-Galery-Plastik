# Referensi Role `accountant` yang Sudah Mati di 17 File Migration Lain

**Modul asal:** Auth / Cross-cutting. **Status:** Ditunda, bukan bug fungsional.

## Kasus

Ditemukan (2026-09-13) saat squash `0030`-`0035` (signup whitelist + role master/single-role) ke `0002_coa_schema.sql`, `0004_counterparty_schema.sql`, `0005_items_schema.sql`, `0010_bom_schema.sql`. Keempat file itu sudah dibersihkan (`role_name in ('admin','accountant')` → `role_name = 'admin'`), tapi role `accountant` juga masih disebut di **17 file migration lain** yang tidak disentuh squash ini: `0003_journal_entry_schema.sql`, `0011_production_orders_schema.sql`, `0012_stock_opname_schema.sql`, `0013_fixed_assets_schema.sql`, `0014_orders_schema.sql`, `0015_transactions_schema.sql`, `0016_payments_schema.sql`, `0017_deposits_schema.sql`, `0018_goods_notes_schema.sql`, `0019_returns_schema.sql`, `0020_return_credits_schema.sql`, `0021_warranty_replacements_schema.sql`, `0022_purchase_replacements_schema.sql`, `0023_inventory_ledger_schema.sql`, `0024_pos_schema.sql` (baris ~80, bentuk 3-nilai `('admin','accountant','cashier')`), `0025_financial_reports_schema.sql`, `0027_replacements_schema.sql`.

## Kenapa bukan bug

`roles` di `0002_coa_schema.sql` sekarang cuma seed `master`/`admin`/`cashier`, dan `user_roles.role_name references roles(name)` (FK) — jadi baris dengan `role_name='accountant'` gak akan pernah bisa ada lagi di database manapun yang dibangun dari migration set saat ini. Check `role_name in ('admin','accountant')` di 17 file itu otomatis tereduksi jadi `= 'admin'` secara fungsional — dead code yang aman, cuma kurang bersih dibaca.

## Kenapa ditunda

Merapikan ini butuh nyentuh 17 file berbeda buat perubahan kosmetik semata (gak ada perubahan behavior). User belum minta ini secara eksplisit — task 2026-09-13 cuma minta squash `0030`-`0035` ke `0002`/`0004`/`0005`/`0010`.

## Kapan perlu digarap

Kapan saja sebagai housekeeping, atau digabung sekalian kalau salah satu dari 17 file ini disentuh lagi buat alasan lain (mis. squash migration baru berikutnya).

## Referensi

- `supabase/migrations/0002_coa_schema.sql` (roles seed final: master/admin/cashier).
- 17 file di atas untuk lokasi persis referensi `'accountant'` yang masih ada.
