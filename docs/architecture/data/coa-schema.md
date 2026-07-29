# Chart of Accounts — Schema (Finalized)

Fase 1 roadmap. Ref konsep bisnis: `docs/domain/human/chart-of-accounts.md` + `docs/domain/ai/chart-of-accounts.md`. Ref state naming: `docs/preferences/system/state-naming-convention.md`.

## Keputusan

- Single-tenant — gak ada `company_id`.
- `normal_balance` derived (`generated always as`) dari `category`, gak bisa diisi manual — nutup celah "salah kategori" (common mistake di domain doc).
- `archived_at` doang buat lifecycle state, `is_active` sengaja dibuang (redundan, resiko gak sinkron). Ref `docs/preferences/system/01-state-naming-convention.md`.
- "Published" (field kritikal terkunci setelah dipakai transaksi) — derived, ditegakkan via DB trigger, BUKAN kolom. Trigger-nya ditulis pas modul Journal Entry (fase 2) dibangun, karena butuh tabel `journal_lines` yang belum ada. Field yang bakal dikunci: `code`, `category`, `normal_balance`, `parent_id`. Field yang tetap boleh diubah kapan pun: `name`, `archived_at`.
- Role pakai lookup table (`roles`), bukan enum — biar nambah role baru gak butuh `ALTER TYPE` migration. `user_roles` PK composite `(user_id, role_name)` — 1 user boleh punya >1 role.

## DDL

### `roles` — daftar role yang diakui sistem

Lookup table, isinya cuma nama role + deskripsi. Alasan pakai tabel (bukan enum Postgres): nambah role baru = `INSERT` baris, bukan migration `ALTER TYPE`. Diisi awal dengan 3 role: `admin` (full access + kelola user/role), `accountant` (create/edit transaksi & COA), `viewer` (read-only).

```sql
create type account_category as enum ('asset','liability','equity','revenue','expense');
create type balance_side as enum ('debit','credit');

create table roles (
  name text primary key,
  description text
);

insert into roles (name, description) values
  ('admin', 'Full access, kelola user & role'),
  ('accountant', 'Create/edit transaksi & COA'),
  ('viewer', 'Read-only');
```

### `user_roles` — role tiap user

Nghubungin user Supabase Auth (`auth.users`) ke `roles`. PK-nya gabungan `(user_id, role_name)`, bukan `user_id` doang — artinya 1 user boleh punya lebih dari 1 role sekaligus (misal accountant + viewer). `on delete cascade`: kalau user dihapus dari `auth.users`, baris role-nya ikut kehapus otomatis, gak nyisain data nyantol.

```sql
create table user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role_name text not null references roles(name),
  primary key (user_id, role_name)
);
```

### `accounts` — tabel inti Chart of Accounts

Tiap baris = 1 akun. Yang perlu diperhatiin dari kolomnya:
- `code`, `name` — identitas akun, `code` unique (gak boleh dobel di seluruh COA).
- `category` — 1 dari 5 kategori (asset/liability/equity/revenue/expense), lihat `docs/domain/human/chart-of-accounts.md`.
- `normal_balance` — **generated column**, bukan input manual. Nilainya dihitung otomatis dari `category` (asset & expense = debit, sisanya = kredit). Ini sengaja biar gak mungkin ada akun dengan kategori dan normal_balance yang gak nyambung (nutup common mistake "salah kategori").
- `parent_id` — self-relasi ke `accounts.id` sendiri, nullable. Ini yang bikin struktur hierarkikal (header/leaf account) jalan — lihat `docs/domain/human/chart-of-accounts.md` bagian Struktur Hierarkikal.
- `archived_at` — nullable, satu-satunya penanda lifecycle (aktif = `NULL`, diarsipkan = keisi timestamp). Gak ada kolom `is_active` terpisah, lihat `docs/preferences/system/state-naming-convention.md` alasannya.

```sql
create table accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category account_category not null,
  normal_balance balance_side generated always as (
    case when category in ('asset','expense') then 'debit'::balance_side
         else 'credit'::balance_side
    end
  ) stored,
  parent_id uuid references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index accounts_parent_id_idx on accounts(parent_id);
```

Index di `parent_id` karena query rollup (cari semua child dari 1 akun) bakal sering jalan pas nyusun laporan — tanpa index, itu full table scan tiap kali buka halaman COA/laporan.

### Trigger `updated_at`

Fungsi generic: tiap kali baris `accounts` di-update, `updated_at` otomatis ke-set ke waktu sekarang. Gak perlu diinget manual di tiap query update dari sisi app.

```sql
create function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger accounts_set_updated_at
  before update on accounts
  for each row execute function set_updated_at();
```

## RLS Policy

RLS = aturan "siapa boleh apa" yang ditegakkan Postgres sendiri di level baris, bukan cuma dicek di kode aplikasi. Ini krusial karena Supabase client (`@supabase/supabase-js`) bisa dipanggil langsung dari browser — kalau cuma app-level check, orang bisa bypass. Detail alasan: `docs/architecture/app/tech-stack-decisions.md`.

**`accounts_select`** — siapa aja yang udah login (`authenticated`) boleh lihat semua akun, termasuk yang diarsipkan. Gak dibatesin per role karena data COA itu referensi, semua role butuh liat buat kerja (misal viewer perlu tau daftar akun buat baca laporan).

**`accounts_insert`** dan **`accounts_update`** — cuma boleh dilakuin user yang punya role `admin` atau `accountant` (dicek lewat subquery ke `user_roles`). `viewer` otomatis ketolak karena gak match kondisi ini.

**Sengaja gak ada policy `DELETE`** — RLS defaultnya deny kalau gak ada policy yang match. Jadi hard-delete ke tabel `accounts` tertutup total buat siapa pun lewat client, termasuk admin. Ini negasin keputusan non-hard-delete kita (arsip doang lewat `archived_at`).

**`user_roles_select_self`** — user cuma boleh lihat role dirinya sendiri (`user_id = auth.uid()`), gak bisa liat role user lain. Belum ada policy INSERT/UPDATE di tabel ini — assign role masih manual/lewat service role, karena butuh `security definer` function biar gak circular-check (lihat catatan "belum termasuk" di bawah).

```sql
alter table accounts enable row level security;

create policy accounts_select on accounts
  for select using (auth.role() = 'authenticated');

create policy accounts_insert on accounts
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy accounts_update on accounts
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> RLS default deny -> hard delete tertutup total

alter table user_roles enable row level security;

create policy user_roles_select_self on user_roles
  for select using (user_id = auth.uid());
```

## Belum termasuk (dependency ke modul lain)

- Trigger "published lock" (`code`/`category`/`normal_balance`/`parent_id` terkunci setelah dipakai transaksi) — butuh `journal_lines`, dibuat pas modul Journal Entry.
- Trigger "leaf-only posting" (tolak posting ke akun yang masih punya child/header account) — juga butuh `journal_lines`, dibuat bareng trigger di atas. Ref konsep: `docs/domain/human/chart-of-accounts.md` bagian Struktur Hierarkikal.
- Policy admin buat assign role user lain — butuh `security definer` function biar gak circular-check ke tabel sendiri. Digarap pas ada screen user management.
