# Tax Settings — Schema (Finalized)

Spine: `tax_settings`. Tabel singleton config PPN, dipakai lintas modul (`transactions`
OUTBOUND untuk PPN Masukan, `pos_sales` untuk PPN Keluaran) — bukan child dari modul
manapun, makanya file sendiri alih-alih ditumpangkan ke salah satu spine transaksional.
Ref konsep bisnis: `docs/domain/accounts-receivable.md` + `docs/domain/accounts-payable.md`
bagian "Kategori Campur & PPN".

## Keputusan

- **Singleton, bukan multi-baris** — `id boolean primary key default true` + `check (id)`
  cuma bisa ada 1 baris selamanya (constraint struktural, bukan RPC yang jaga).
- **PPN dihitung server-side, gak pernah dipercaya dari input klien** — beda perlakuan
  dari kategori bebas (`p_lines`). `is_tax` di `transaction_lines` gak pernah diisi dari
  JSON klien, cuma RPC yang set `true` pas insert baris PPN-nya sendiri. Sebelumnya
  (interim, migration `0022`) PPN dicatat manual lewat `create_journal_entry` di luar
  RPC utama — gak traceable ke transaksi manapun (`memory/scope-debt/tax-handling.md`,
  sudah dihapus, riwayat resolusinya diringkas di sini).
- **Tarif PPN aturan pemerintah (nasional)** — disimpan di DB bukan di-hardcode di kode,
  biar ganti tarif cukup 1 `UPDATE`, gak perlu deploy ulang.

## DDL

```sql
create table tax_settings (
  id boolean primary key default true check (id),
  is_active boolean not null default false,
  ppn_rate numeric(5,2) not null default 11,
  ppn_keluaran_account_id uuid references accounts(id),
  ppn_masukan_account_id uuid references accounts(id),
  updated_at timestamptz not null default now()
);
```

- `is_active` — apakah bisnis ini sekarang wajib pungut PPN. Beda dari `archived_at`
  katalog master data lain — ini flag konfigurasi, bukan lifecycle per-baris.
- `ppn_rate` — tarif PPN (11% default), dipakai `create_transaction`/`create_pos_sale`.
- `ppn_keluaran_account_id`/`ppn_masukan_account_id` — FK `accounts`, dipetakan ke akun
  `2400`/`1500` yang diseed di file yang sama.

## Pemakai

- **`create_transaction`** (`transactions-schema.md`) — sisi OUTBOUND (AP), `p_apply_tax=true`
  baca `ppn_masukan_account_id`/`ppn_rate`, `raise exception` kalau `is_active=false` atau
  akun belum diset. PPN ditambahkan ke `p_control_account_id` (utang ke supplier termasuk
  pajak yang bisa dikreditkan).
- **`create_pos_sale`** (`pos-schema.md`) — PPN Keluaran, mekanisme sama.

## RLS & Grant

`select` semua `authenticated`, `update` admin doang, **gak ada insert/delete** (baris
tunggalnya cuma diseed migration, constraint singleton nolak baris kedua).

Full body: `supabase/migrations/0025_compound_transactional_entries_schema.sql`.
