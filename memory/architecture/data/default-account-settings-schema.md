# Default Account Settings — Schema

Padanan naratif: `docs/architecture/default-account-settings-schema.md`. Cross-cutting seperti `document-numbering-schema.md` — bukan bagian dari 1 modul tunggal, menyentuh hampir semua form transaksi di seluruh aplikasi.

## Masalah

Sebelum ini, form transaksi (AR Invoice, AP Bill, Goods Issue, Goods Receipt, Production Order, Sales Order, AR/AP Deposit, Items, Stock Opname, dan hampir semua panel aksi di halaman detail — retur, payment, refund, terapkan/hanguskan DP, penggantian barang) nyuruh user milih BEBAS akun COA (`leafAccounts.map(...)` di raw `<Select>`) buat baris yang sebenarnya SELALU resolve ke akun yang sama tiap kali (mis. "Akun Piutang Usaha" di AR Invoice selalu `1300 Piutang Usaha`). Ini sudah kejadian jadi bug nyata: panel Retur AP Bill pernah kena field "Akun Utang Usaha (debit)" diisi akun Kas, jurnal excess salah arah.

## `default_account_settings` — mapping tetap 1 akun per "peran"

Pola singleton-per-baris niru `tax_settings` (`memory/architecture/data/tax-settings-schema.md`) — baris diseed migration, admin cuma `UPDATE account_id`, **sengaja gak ada policy INSERT** (`role_key` yang valid ditentukan kode FE, bukan bebas ditambah admin).

```sql
create table default_account_settings (
  id uuid primary key default gen_random_uuid(),
  role_key text not null unique,
  label text not null,
  account_id uuid not null references accounts(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
```

Seed 19 baris (`0017_default_account_settings_schema.sql` + follow-up `0018_default_account_settings_stock_opname.sql`, 2 role_key ketinggalan di sweep pertama):

| role_key | akun | dipakai di |
|---|---|---|
| `ar.receivable` | 1300 Piutang Usaha | AR Invoice, Goods Issue, Sales Order fulfillment, dan hampir semua panel aksi AR (DP, retur, payment) |
| `ar.revenue` | 4200 Pendapatan Penjualan Grosir | baris kredit primer AR Invoice/Goods Issue/Sales Order (kategori TAMBAHAN tetap lewat `charge_categories` module `ar`, gak berubah) |
| `ar.contra_revenue` | 4900 Retur & Potongan Penjualan | panel Retur & Penggantian Barang AR |
| `ar.deposit_liability` | 2300 Uang Muka Penjualan | AR Deposit (create, terapkan, refund, hangus) |
| `ar.writeoff_expense` | 5700 Beban Piutang Tak Tertagih | **orphaned** — fitur Piutang Tak Tertagih dicabut total migration `0064`+`0065` (2026-09-05), row seed ini dibiarkan (konvensi: config lama gak dibersihkan setelah fitur dicabut, lihat `document_number_types` di `memory/architecture/data/document-numbering-schema.md`) |
| `ar.return_credit_liability` | 2500 Saldo Kredit Retur Customer | panel Retur/Penggantian Barang/Refund saldo kredit AR |
| `ar.other_revenue` | 4300 Pendapatan Lain-lain | panel Hanguskan AR Deposit |
| `ap.payable` | 2100 Utang Usaha | AP Bill dan hampir semua panel aksi AP (DP, payment, retur) |
| `ap.return_credit_asset` | 1350 Piutang Retur Supplier | panel Retur & Refund AP Bill |
| `ap.deposit_asset` | 1360 Uang Muka Pembelian | AP Deposit (create, terapkan, refund, hangus) |
| `ap.deposit_loss_expense` | 5800 Beban Kerugian Uang Muka | panel Hanguskan AP Deposit |
| `inventory.raw_material` | 1400 Persediaan Bahan Baku | Goods Receipt, Production Order (kredit), item `RAW_MATERIAL`, panel Tukar Barang AP |
| `inventory.finished_good` | 1420 Persediaan Barang Jadi | Goods Issue, Production Order (debit), item `FINISHED_GOOD`, panel Retur/Penggantian Barang AR |
| `inventory.hpp` | 5100 Harga Pokok Penjualan | Goods Issue, Sales Order fulfillment, panel Retur/Penggantian Barang AR |
| `inventory.damage_loss_expense` | 5900 Beban Kerugian Barang Rusak | panel Retur AR (baris Rusak) — padanan AP (Write-off Opsi C) dicabut total migration `0068` |
| `inventory.shortage_expense` | 6000 Beban Selisih Persediaan | Stock Opname |
| `inventory.surplus_revenue` | 4400 Pendapatan Selisih Persediaan | Stock Opname |
| `cash.tunai` | 1100 Kas Toko | semua field "Akun Kas/Bank", sisi tunai |
| `cash.bank` | 1200 Kas di Bank | semua field "Akun Kas/Bank", sisi transfer/QRIS |

## `fixed_asset_account_presets` — beda pola, katalog bukan singleton

Fixed Assets butuh 3 akun sekaligus (aset/akumulasi/beban) DAN jenis aset baru tetap mungkin muncul (bukan set role tetap yang diketahui di awal) — jadi bukan `default_account_settings`, tapi katalog niru `charge_categories`: admin daftarkan 1 preset per JENIS aset, form Fixed Assets pilih 1 preset (bukan 3 akun terpisah) — mencegah kombinasi ketuker (mis. akun Aset "Rak" dipasangkan Akumulasi "Mobil Pickup").

```sql
create table fixed_asset_account_presets (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  asset_account_id uuid not null references accounts(id),
  accumulated_depreciation_account_id uuid not null references accounts(id),
  depreciation_expense_account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Seed 2 baris (pasangan yang sudah ada dari `0016_rename_legacy_fixed_asset_accounts.sql`): "Rak Display Toko" (1610/1630/5600) dan "Mobil Pickup Antar Barang" (1620/1640/5610).

## Kasus khusus — AP Bill retur, akun kredit DERIVED bukan FIXED

Field "Akun Persediaan/Beban (kredit)" di panel Retur AP Bill (`ap-bills/[id]/view.tsx`, RPC `create_ap_credit_note`) — ini persis lokasi bug nyata yang jadi pemicu fitur ini. Gak dijadiin `default_account_settings` baru karena akunnya HARUS sama dengan akun debit asli di bill itu (retur ngurangin persis apa yang tadinya dicatat) — kalau bill punya beberapa baris debit (compounding), akunnya bisa beda-beda per bill, bukan 1 nilai tetap.

Solusi: field ini dibatasi ke `ap_bill_debit_lines` milik bill yang bersangkutan doang (`select account_id, accounts(code,name) from ap_bill_debit_lines where ap_bill_id = :id and is_tax = false`, di-dedupe) — bukan bebas pilih dari seluruh COA, tapi juga bukan 1 akun terkunci. Kalau cuma 1 baris debit (kasus umum), pilihan efektif cuma 1. Kalau lebih dari 1, user pilih yang mana yang lagi diretur — pilihan yang genuinely perlu dibuat, tapi dibatasi ke akun yang beneran relevan ke bill ini.

## Kasus khusus — Items, role_key derived dari `item_type`

Field "Akun Persediaan" di form Items (`items/page.tsx`) gak nanya user langsung — resolve otomatis dari `item_type` yang udah dipilih di field sebelumnya: `RAW_MATERIAL` → `inventory.raw_material`, `FINISHED_GOOD` → `inventory.finished_good`. Sama prinsipnya kayak field Kas/Bank (pilihan sebenarnya udah dibuat di field lain, akun tinggal ikut).

## UI Pattern (Frontend)

- **`apps/erp/src/lib/default-accounts/schema.ts`** — `fetchDefaultAccounts()` (query `default_account_settings` join `accounts(code,name)`, return `Record<role_key, ResolvedAccount>`) + `fetchFixedAssetAccountPresets()`.
- **`apps/erp/src/components/ui/locked-account-field.tsx`** — `<LockedAccountField label roleKey.../>`, render read-only "CODE — NAME". Kalau `resolved` undefined (role_key belum di-set admin), tampil warning merah + link ke Settings — **gak pernah fallback ke picker bebas**.
- **`apps/erp/src/components/ui/cash-method-field.tsx`** — `<CashMethodField/>`, 2 tombol toggle Tunai/Transfer Bank (niru pola `ACCOUNT_CODES` yang sudah dipakai `apps/pos`, cuma sumbernya dari DB bukan hardcode kode di file), `resolveCashAccount(method, defaultAccounts)` buat ambil id saat submit.
- **Halaman admin**: `/settings/charges` — section baru "Default Akun" (edit inline per baris `default_account_settings`) + "Preset Akun Aset Tetap" (tambah/nonaktifkan `fixed_asset_account_presets`), di atas 3 `CatalogManager` + `TaxSettingsCard` yang udah ada.

## RLS + Grant

`default_account_settings`: select=authenticated, update=admin doang, **gak ada insert** (persis pola `tax_settings`). `fixed_asset_account_presets`: select=authenticated, insert+update=admin, nonaktifkan pakai `archived_at` (persis pola `charge_categories`).

## Yang SENGAJA gak disentuh mekanisme ini

- **Journal Entries manual** (`/journal-entries`) — ini justru ALAT buat entry akun bebas, by design (dipakai admin/accountant buat transaksi yang gak match pola RPC manapun). Kalau ini ikut dikunci, gak ada jalan buat transaksi non-standar.
- **Kategori pendapatan/beban TAMBAHAN** (`charge_categories`, module `ar`/`ap`/`pos`) — mekanisme lama yang udah bener sejak awal (compounding, migration `0025` versi sebelum squash), genuinely butuh pilihan (nama kategori beda-beda), gak diganti.
- **Filter dropdown akun** di `/general-ledger` (pilih akun mana yang mau dilihat ledgernya) — bukan field posting/transaksi, cuma query read-only.
