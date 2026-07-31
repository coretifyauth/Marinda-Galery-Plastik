# Fixed Assets — Schema (Finalized)

Fase 6 roadmap. Ref konsep bisnis: `docs/domain/human/fixed-assets.md` + `docs/domain/ai/fixed-assets.md`. Ref akun kontra: `docs/domain/human/chart-of-accounts.md` bagian "Akun Kontra" + `docs/scope-debt/fixed-assets-akun-kontra-asset.md`. Ref schema yang di-reuse: `docs/architecture/data/journal-entry-schema.md` (RPC `create_journal_entry`, fungsi `set_updated_at()`+`block_edit_delete()`), `docs/architecture/data/coa-schema.md` (tabel `accounts` yang kena `ALTER`).

## Keputusan

- **`accounts.is_contra`** (Opsi A dari scope-debt) — kolom baru, generated column `normal_balance` diubah rumusnya biar ikut flag ini. Postgres gak bisa `ALTER` ekspresi generated column langsung — migration-nya `DROP COLUMN normal_balance` lalu `ADD COLUMN` ulang dengan rumus baru (data existing aman, semua akun lama `is_contra` default `false`, hasil generated-nya sama persis kayak sebelumnya).
- **2 metode penyusutan in-scope**: `straight_line` & `declining_balance` (`depreciation_method` enum di `fixed_assets`). Unit produksi ditunda (`docs/scope-debt/`).
- **`depreciation_rate` mewakili tarif PER PERIODE POSTING**, bukan otomatis per-tahun — kalau posting bulanan, rate yang diinput ya tarif bulanan. Ini sengaja dibikin eksplisit (bukan disimpan sebagai tarif tahunan terus dibagi 12 di RPC) biar gak ada ambiguitas konversi periode di 2 tempat beda (dokumentasi vs kode).
- **3 akun per aset** (asset, akumulasi penyusutan, beban penyusutan), divalidasi kategori & `is_contra`-nya lewat trigger insert — bukan cuma dipercaya dari sisi app, karena Supabase client bisa dipanggil langsung dari browser (sama alasan RLS wajib di semua tabel).
- **Cap penyusutan ditegakkan trigger di `depreciation_entries`**, bukan cuma dihitung benar di RPC — kalau ada insert langsung yang bypass RPC, cap tetap ketutup (pola sama `journal_lines_leaf_only`/`journal_lines_balance_check`, invariant dijaga di DB bukan cuma di app).
- **Immutability `depreciation_entries`** — reuse `block_edit_delete()`, koreksi cuma lewat `reverse_journal_entry` + insert entry baru (posting ulang), sama pola AR/AP/GL.
- **`fixed_assets` published-lock** — begitu punya minimal 1 `depreciation_entries`, field penentu nilai (`acquisition_cost`, `salvage_value`, `useful_life_months`, `depreciation_method`, `depreciation_rate`, 3 kolom akun) terkunci. `name`/`archived_at` tetap bebas.
- Money `numeric(14,2)`, `depreciation_rate` `numeric(5,4)` (representasi desimal, `0.40` = 40%) — bukan float (invariant `AGENT.md`).

## DDL

### `accounts` — `ALTER` nambah `is_contra`

```sql
alter table accounts add column is_contra boolean not null default false;

alter table accounts drop column normal_balance;

alter table accounts add column normal_balance balance_side generated always as (
  case
    when category in ('asset','expense') then
      case when is_contra then 'credit'::balance_side else 'debit'::balance_side end
    else
      case when is_contra then 'debit'::balance_side else 'credit'::balance_side end
  end
) stored;
```

Data existing aman: semua akun lama `is_contra=false` (default), hasil `normal_balance` generated-nya identik sama sebelum migration ini jalan.

### `accounts_published_lock` — `is_contra` ikut masuk daftar field terkunci

Redefinisi (`create or replace`) dari `journal-entry-schema.md`, nambah `is_contra` ke tuple yang dibandingin — begitu akun kepakai jurnal, gak boleh diam-diam diubah dari kontra jadi non-kontra atau sebaliknya.

```sql
create or replace function accounts_published_lock() returns trigger as $$
begin
  if (old.code, old.category, old.normal_balance, old.parent_id, old.is_contra)
     is distinct from (new.code, new.category, new.normal_balance, new.parent_id, new.is_contra) then
    if exists (select 1 from journal_lines where account_id = old.id) then
      raise exception 'Akun % sudah dipakai di jurnal — code/category/normal_balance/parent_id/is_contra terkunci', old.code;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
```

Trigger-nya sendiri (`accounts_published_lock_trigger`) gak perlu dibuat ulang — `create or replace function` cukup, trigger existing otomatis pakai definisi baru.

### `fixed_assets` — master data tiap unit aset tetap

Satu baris = satu unit aset fisik (1 oven, 1 motor), bukan kategori. Yang perlu diperhatiin dari kolomnya:
- `asset_account_id`, `accumulated_depreciation_account_id`, `depreciation_expense_account_id` — 3 akun COA yang dipetakan ke aset ini. Divalidasi lewat trigger `fixed_assets_validate_accounts` (bukan `CHECK` constraint biasa — Postgres gak bisa `CHECK` yang query tabel lain).
- `useful_life_months` — satuan bulan (bukan tahun), biar penyusutan bulanan presisi tanpa pembagian ulang di RPC.
- `depreciation_rate` — nullable, wajib keisi kalau `depreciation_method='declining_balance'`, wajib `null` kalau `straight_line` (ditegakkan `check` constraint biasa, karena ini validasi antar-kolom di baris yang sama, bukan lintas tabel).
- Gak ada kolom `normal_balance`/kategori di sini — itu urusan tabel `accounts` yang direferensi, `fixed_assets` cuma nunjuk `id`-nya.

```sql
create type depreciation_method as enum ('straight_line', 'declining_balance');

create table fixed_assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  asset_account_id uuid not null references accounts(id),
  accumulated_depreciation_account_id uuid not null references accounts(id),
  depreciation_expense_account_id uuid not null references accounts(id),
  acquisition_cost numeric(14,2) not null check (acquisition_cost > 0),
  salvage_value numeric(14,2) not null default 0 check (salvage_value >= 0),
  useful_life_months int not null check (useful_life_months > 0),
  acquisition_date date not null,
  depreciation_method depreciation_method not null default 'straight_line',
  depreciation_rate numeric(5,4) check (depreciation_rate > 0 and depreciation_rate <= 1),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (depreciation_method = 'straight_line' and depreciation_rate is null)
    or
    (depreciation_method = 'declining_balance' and depreciation_rate is not null)
  ),
  check (salvage_value < acquisition_cost)
);

create index fixed_assets_asset_account_id_idx on fixed_assets(asset_account_id);

create trigger fixed_assets_set_updated_at
  before update on fixed_assets
  for each row execute function set_updated_at();
```

`set_updated_at()` di-reuse dari `coa-schema.md`. `salvage_value < acquisition_cost` — nilai residu gak masuk akal kalau sama/lebih dari nilai perolehan (gak ada yang perlu disusutkan).

### `depreciation_entries` — histori posting penyusutan per periode

Satu baris = satu periode (bulan) penyusutan untuk satu aset. `amount` disimpan eksplisit (bukan re-derive dari formula) — keputusan ini yang bikin `declining_balance` (nilainya beda tiap periode) gak butuh kolom tambahan apapun dibanding `straight_line`.

```sql
create table depreciation_entries (
  id uuid primary key default gen_random_uuid(),
  fixed_asset_id uuid not null references fixed_assets(id),
  period date not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (fixed_asset_id, period)
);

create index depreciation_entries_fixed_asset_id_idx on depreciation_entries(fixed_asset_id);
```

`unique (fixed_asset_id, period)` — cegah dobel-posting bulan yang sama buat aset yang sama.

## Trigger

### `fixed_assets_validate_accounts` — pastikan 3 akun yang dipetakan sesuai peran masing-masing

Cegah salah pasang akun dari sisi UI/typo — misal `accumulated_depreciation_account_id` ditunjuk ke akun yang bukan kontra, atau `depreciation_expense_account_id` ditunjuk ke akun kategori asset.

```sql
create function fixed_assets_validate_accounts() returns trigger as $$
declare
  v_asset_category account_category;
  v_asset_is_contra boolean;
  v_accum_category account_category;
  v_accum_is_contra boolean;
  v_expense_category account_category;
begin
  select category, is_contra into v_asset_category, v_asset_is_contra
    from accounts where id = new.asset_account_id;
  if v_asset_category <> 'asset' or v_asset_is_contra then
    raise exception 'asset_account_id harus akun kategori asset, non-kontra';
  end if;

  select category, is_contra into v_accum_category, v_accum_is_contra
    from accounts where id = new.accumulated_depreciation_account_id;
  if v_accum_category <> 'asset' or not v_accum_is_contra then
    raise exception 'accumulated_depreciation_account_id harus akun kategori asset DAN is_contra=true';
  end if;

  select category into v_expense_category
    from accounts where id = new.depreciation_expense_account_id;
  if v_expense_category <> 'expense' then
    raise exception 'depreciation_expense_account_id harus akun kategori expense';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger fixed_assets_validate_accounts_trigger
  before insert or update on fixed_assets
  for each row execute function fixed_assets_validate_accounts();
```

### `depreciation_entries_cap_check` — tolak penyusutan yang ngelewatin batas

Constraint domain wajib (`fixed-assets.md`): akumulasi gak boleh melebihi `acquisition_cost - salvage_value`. Ditegakkan di level trigger DB, bukan cuma dipercaya dari perhitungan RPC — biar cap ini tetap ketutup meski ada insert yang bypass RPC.

```sql
create function depreciation_entries_cap_check() returns trigger as $$
declare
  v_cost numeric;
  v_salvage numeric;
  v_accumulated numeric;
begin
  select acquisition_cost, salvage_value into v_cost, v_salvage
    from fixed_assets where id = new.fixed_asset_id;

  select coalesce(sum(amount), 0) into v_accumulated
    from depreciation_entries where fixed_asset_id = new.fixed_asset_id;

  if v_accumulated + new.amount > v_cost - v_salvage then
    raise exception 'Penyusutan aset % melebihi batas (sisa %, coba %)',
      new.fixed_asset_id, (v_cost - v_salvage) - v_accumulated, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger depreciation_entries_cap_check_trigger
  before insert on depreciation_entries
  for each row execute function depreciation_entries_cap_check();
```

### Immutability — reuse `block_edit_delete()`

```sql
create trigger depreciation_entries_block_edit_delete
  before update or delete on depreciation_entries
  for each row execute function block_edit_delete();
```

### `fixed_assets_published_lock` — kunci field penentu nilai setelah ada penyusutan

Pola sama `accounts_published_lock`. Field terkunci: 3 kolom akun, `acquisition_cost`, `salvage_value`, `useful_life_months`, `acquisition_date`, `depreciation_method`, `depreciation_rate`. Yang tetap bebas: `name`, `archived_at`.

```sql
create function fixed_assets_published_lock() returns trigger as $$
begin
  if (old.asset_account_id, old.accumulated_depreciation_account_id, old.depreciation_expense_account_id,
      old.acquisition_cost, old.salvage_value, old.useful_life_months, old.acquisition_date,
      old.depreciation_method, old.depreciation_rate)
     is distinct from
     (new.asset_account_id, new.accumulated_depreciation_account_id, new.depreciation_expense_account_id,
      new.acquisition_cost, new.salvage_value, new.useful_life_months, new.acquisition_date,
      new.depreciation_method, new.depreciation_rate) then
    if exists (select 1 from depreciation_entries where fixed_asset_id = old.id) then
      raise exception 'Aset % sudah punya penyusutan — field nilai/akun/metode terkunci', old.id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger fixed_assets_published_lock_trigger
  before update on fixed_assets
  for each row execute function fixed_assets_published_lock();
```

## RPC (financial write — atomik)

### `create_fixed_asset` — insert master data doang, gak ada jurnal

Akuisisi (Debit Aset Tetap, Kredit Kas/Utang) dicatat manual lewat `create_journal_entry` biasa — itu transaksi generik, gak butuh RPC khusus. `create_fixed_asset` cuma nyimpen master data buat dasar penyusutan berikutnya.

```sql
create function create_fixed_asset(
  p_name text,
  p_asset_account_id uuid,
  p_accumulated_depreciation_account_id uuid,
  p_depreciation_expense_account_id uuid,
  p_acquisition_cost numeric,
  p_salvage_value numeric,
  p_useful_life_months int,
  p_acquisition_date date,
  p_depreciation_method depreciation_method default 'straight_line',
  p_depreciation_rate numeric default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_asset_id uuid;
begin
  insert into fixed_assets (
    name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
    acquisition_cost, salvage_value, useful_life_months, acquisition_date,
    depreciation_method, depreciation_rate
  )
  values (
    p_name, p_asset_account_id, p_accumulated_depreciation_account_id, p_depreciation_expense_account_id,
    p_acquisition_cost, p_salvage_value, p_useful_life_months, p_acquisition_date,
    p_depreciation_method, p_depreciation_rate
  )
  returning id into v_asset_id;

  return v_asset_id;
end;
$$;
```

### `post_depreciation` — hitung (atau terima override) + bikin jurnal + insert entry, atomik

Formula otomatis per `depreciation_method`. `p_amount_override` dipakai buat penyesuaian manual periode terakhir (declining balance, potongan biar pas residu — lihat `fixed-assets.md`); kalau `null`, dihitung otomatis.

```sql
create function post_depreciation(
  p_fixed_asset_id uuid,
  p_period date,
  p_source_ref text,
  p_amount_override numeric default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_asset fixed_assets%rowtype;
  v_accumulated numeric;
  v_book_value numeric;
  v_amount numeric;
  v_cap numeric;
  v_entry_id uuid;
  v_de_id uuid;
begin
  select * into v_asset from fixed_assets where id = p_fixed_asset_id;

  select coalesce(sum(amount), 0) into v_accumulated
    from depreciation_entries where fixed_asset_id = p_fixed_asset_id;

  v_cap := v_asset.acquisition_cost - v_asset.salvage_value;
  v_book_value := v_asset.acquisition_cost - v_accumulated;

  if p_amount_override is not null then
    v_amount := p_amount_override;
  elsif v_asset.depreciation_method = 'straight_line' then
    v_amount := v_cap / v_asset.useful_life_months;
  else -- declining_balance
    v_amount := v_book_value * v_asset.depreciation_rate;
  end if;

  -- potong otomatis kalau lewat cap (lihat catatan teknis declining balance, fixed-assets.md)
  if v_accumulated + v_amount > v_cap then
    v_amount := v_cap - v_accumulated;
  end if;

  v_entry_id := create_journal_entry(
    p_period, 'Penyusutan ' || v_asset.name, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', v_asset.depreciation_expense_account_id, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', v_asset.accumulated_depreciation_account_id, 'debit', 0, 'credit', v_amount)
    )
  );

  insert into depreciation_entries (fixed_asset_id, period, amount, journal_entry_id, created_by)
  values (p_fixed_asset_id, p_period, v_amount, v_entry_id, auth.uid())
  returning id into v_de_id;

  return v_de_id;
end;
$$;
```

Potongan-cap di RPC ini cuma buat kenyamanan (auto-adjust, gak perlu hitung manual pas periode terakhir) — `depreciation_entries_cap_check_trigger` tetep jalan sebagai jaring kedua kalau ada jalur insert lain yang gak lewat RPC ini.

## RLS Policy

Pola identik AR/AP/Inventory — `select` terbuka buat semua `authenticated`, `insert` cuma `admin`/`accountant`, gak ada `delete` (arsip lewat `archived_at` di `fixed_assets`, immutability trigger di `depreciation_entries`).

**`fixed_assets_update`** — dibolehin (beda dari `depreciation_entries` yang gak ada update sama sekali), karena `name`/`archived_at` emang harus bisa diubah kapan pun; field yang gak boleh diubah udah dijaga trigger `fixed_assets_published_lock`, bukan RLS. Sama pola kayak `accounts_update` di `coa-schema.md`.

```sql
alter table fixed_assets enable row level security;

create policy fixed_assets_select on fixed_assets
  for select using (auth.role() = 'authenticated');

create policy fixed_assets_insert on fixed_assets
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy fixed_assets_update on fixed_assets
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at, hard delete tertutup total

alter table depreciation_entries enable row level security;

create policy depreciation_entries_select on depreciation_entries
  for select using (auth.role() = 'authenticated');

create policy depreciation_entries_insert on depreciation_entries
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny + trigger block_edit_delete, 2 lapis
```

## Grant

```sql
grant select, insert, update on fixed_assets to authenticated;
grant select, insert on depreciation_entries to authenticated;
```

## Belum termasuk (dependency / di luar scope fase ini)

Detail lengkap tiap item: `docs/scope-debt/` dan `docs/domain/human/fixed-assets.md` bagian "Belum Termasuk".

- **Disposal aset** — belum ada RPC/tabel buat catat penjualan/pembuangan aset & laba-rugi disposal-nya.
- **Metode Unit Produksi** — butuh data pemakaian eksternal per periode, potensi coupling ke `production_orders` (Inventory).
- **Revaluasi aset**.
- **Ganti metode penyusutan di tengah umur manfaat aset** — butuh proses revaluasi formal, bukan `UPDATE` biasa (udah ditutup `fixed_assets_published_lock` dari sisi "gak bisa diam-diam ganti", tapi belum ada jalur resmi buat ganti dengan sengaja lewat proses yang benar).
