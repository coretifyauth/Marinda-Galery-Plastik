# Journal Entry & General Ledger — Schema (Finalized)

Fase 2 roadmap. Ref konsep bisnis: `docs/domain/general-ledger.md` + `memory/domain/general-ledger.md`. Ref ERD & keputusan draft/posted: dibahas di percakapan, hasil finalnya di file ini + `memory/architecture/app/tech-stack-decisions.md` (entri "Journal Entry: no draft/posted workflow"). Ref schema COA yang kena dampak: `memory/architecture/data/coa-schema.md`.

## Keputusan

- **Gak ada draft/posted workflow** — entry final begitu dibuat & lolos validasi (lihat `tech-stack-decisions.md`). Gak ada kolom `status`/`posted_at`.
- **Immutability 2 lapis** — RLS sengaja gak ada policy `UPDATE`/`DELETE` (default deny), DITAMBAH trigger yang selalu `RAISE EXCEPTION` di `UPDATE`/`DELETE` sebagai jaring kedua (kalau suatu saat grant/policy salah dikonfigurasi, trigger tetep nahan).
- **Koreksi cuma lewat reversing entry** — disediain lewat RPC `reverse_journal_entry`, bukan manual, biar gak ada risiko lupa nge-link `reverses_entry_id` atau salah nuker debit/kredit.
- **Balance check pakai deferred constraint trigger** — divalidasi pas `COMMIT`, bukan per baris insert, karena baris pertama dari sebuah entry pasti "kelihatan" gak balance sebelum baris pasangannya masuk.
- **2 trigger baru nempel di tabel `accounts`** (Fase 1) — closing 2 item yang sengaja ditunda di `coa-schema.md`, plus 1 edge case baru: cegah akun yang udah dipakai jurnal diam-diam jadi header lewat child baru.
- Money pakai `numeric(14,2)`, bukan float (invariant di `AGENT.md`).

## DDL

### `journal_entries` — header transaksi

Satu baris = satu kejadian bisnis. Yang perlu diperhatiin:
- `source_ref` — **wajib diisi** (`not null`), bukan opsional. Ini penegakan constraint domain "traceability ke source document" (`general-ledger.md`) — tanpa ini, entry gak bisa diverifikasi ke bukti fisiknya.
- `reverses_entry_id` — self-FK nullable, nunjuk ke entry lain yang dibalik oleh entry ini. Diisi otomatis lewat RPC `reverse_journal_entry`, bukan diisi manual dari client.
- **Gak ada `updated_at`/`archived_at`** — entry gak pernah diedit atau diarsipkan, sekali ada, permanen di histori (lihat "Keputusan" di atas).

```sql
create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  description text,
  source_ref text not null,
  reverses_entry_id uuid references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

### `journal_lines` — baris debit/kredit

Tiap baris nunjuk ke 1 akun COA + 1 sisi (debit atau kredit). Yang perlu diperhatiin:
- `debit`/`credit` dua kolom terpisah (bukan `amount`+`side` enum) — pola standar software akuntansi, gampang di-`SUM()` per kolom pas hitung saldo akun.
- Constraint `check` mastiin **cuma satu sisi yang keisi** per baris — gak boleh dua-duanya 0 (baris kosong gak ada gunanya) atau dua-duanya keisi (itu 2 fakta beda, harusnya 2 baris).
- `account_id` **wajib leaf** (gak punya child) — ditegakkan trigger `journal_lines_leaf_only`, bukan constraint SQL biasa (Postgres gak bisa nge-`CHECK` "gak punya child" langsung di kolom).

```sql
create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references journal_entries(id) on delete cascade,
  account_id uuid not null references accounts(id),
  debit numeric(14,2) not null default 0,
  credit numeric(14,2) not null default 0,
  check ((debit > 0 and credit = 0) or (debit = 0 and credit > 0))
);

create index journal_lines_journal_entry_id_idx on journal_lines(journal_entry_id);
create index journal_lines_account_id_idx on journal_lines(account_id);
```

Index di `journal_entry_id` buat query "semua baris 1 entry" (dipakai trigger balance-check tiap commit). Index di `account_id` buat query "hitung saldo 1 akun" (bakal sering dipanggil pas laporan/rollup).

## Trigger

### `journal_lines_leaf_only` — tolak posting ke akun header

Constraint domain #3 (`general-ledger.md`): cuma leaf account yang boleh diposting. Trigger ini jalan tiap ada baris baru, cek apakah `account_id`-nya punya child di `accounts` — kalau iya, tolak.

```sql
create function journal_lines_leaf_only() returns trigger as $$
begin
  if exists (select 1 from accounts where parent_id = new.account_id) then
    raise exception 'Akun % adalah header (punya child), gak boleh diposting langsung', new.account_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger journal_lines_leaf_only_trigger
  before insert on journal_lines
  for each row execute function journal_lines_leaf_only();
```

### `journal_lines_balance_check` — tolak entry yang gak balance atau kurang dari 2 baris

Constraint domain #1 & #2. Ini **deferred constraint trigger** — bedanya dari trigger biasa, dia dijadwalin jalan pas transaksi mau `COMMIT`, bukan langsung tiap baris masuk. Kenapa harus gitu: kalau dicek per baris, baris pertama sebuah entry selalu "kelihatan" gak balance (baris pasangannya belum ada). Karena RPC `create_journal_entry` masukin header+semua lines dalam 1 transaksi, deferred trigger ini pas jadi "pengecekan akhir" pas semua baris udah lengkap.

```sql
create function journal_lines_balance_check() returns trigger as $$
declare
  v_entry_id uuid := coalesce(new.journal_entry_id, old.journal_entry_id);
  v_count int;
  v_debit numeric;
  v_credit numeric;
begin
  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_count, v_debit, v_credit
  from journal_lines where journal_entry_id = v_entry_id;

  if v_count < 2 then
    raise exception 'Journal entry % minimal 2 baris (ada %)', v_entry_id, v_count;
  end if;

  if v_debit <> v_credit then
    raise exception 'Journal entry % gak balance: debit % != kredit %', v_entry_id, v_debit, v_credit;
  end if;

  return null;
end;
$$ language plpgsql;

create constraint trigger journal_lines_balance_check_trigger
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function journal_lines_balance_check();
```

### `block_edit_delete` — jaring kedua buat immutability

RLS udah nolak `UPDATE`/`DELETE` lewat default-deny (gak ada policy-nya). Trigger ini nolak lagi di level lain — kalau suatu saat ada yang salah kasih grant/policy, ini tetep nahan.

```sql
create function block_edit_delete() returns trigger as $$
begin
  raise exception 'journal_entries/journal_lines gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
end;
$$ language plpgsql;

create trigger journal_entries_block_edit_delete
  before update or delete on journal_entries
  for each row execute function block_edit_delete();

create trigger journal_lines_block_edit_delete
  before update or delete on journal_lines
  for each row execute function block_edit_delete();
```

### `accounts_published_lock` — kunci akun yang udah kepakai (dari `coa-schema.md`, ditunda ke sini)

Begitu akun dipakai di `journal_lines` mana pun, `code`/`category`/`normal_balance`/`parent_id` terkunci — implementasi "published" di `state-naming-convention.md` (derived, bukan kolom manual). `name`/`archived_at` tetap bebas diubah kapan pun.

```sql
create function accounts_published_lock() returns trigger as $$
begin
  if (old.code, old.category, old.normal_balance, old.parent_id)
     is distinct from (new.code, new.category, new.normal_balance, new.parent_id) then
    if exists (select 1 from journal_lines where account_id = old.id) then
      raise exception 'Akun % sudah dipakai di jurnal — code/category/normal_balance/parent_id terkunci', old.code;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger accounts_published_lock_trigger
  before update on accounts
  for each row execute function accounts_published_lock();
```

### `accounts_no_retroactive_header` — edge case yang ketemu waktu bedah domain

Tanpa ini, akun leaf yang udah keposting bisa diam-diam jadi header cuma dengan nambah akun baru yang `parent_id`-nya nunjuk ke situ — ngelanggar leaf-only-posting secara retroaktif buat histori yang udah ada. Trigger ini nolak `insert` akun baru kalau calon parent-nya udah "published" (udah dipakai di jurnal).

```sql
create function accounts_no_retroactive_header() returns trigger as $$
begin
  if new.parent_id is not null and exists (
    select 1 from journal_lines where account_id = new.parent_id
  ) then
    raise exception 'Akun induk (parent_id) sudah dipakai di jurnal — gak bisa ditambah child baru (bakal jadi header retroaktif)';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger accounts_no_retroactive_header_trigger
  before insert on accounts
  for each row execute function accounts_no_retroactive_header();
```

## RPC (financial write — atomik)

Sesuai `tech-stack-decisions.md`: financial writes lewat Postgres RPC biar header+lines commit bareng dalam 1 transaksi. Dua-duanya `security invoker` (bukan `security definer`) — jalan pakai hak akses user yang manggil, jadi RLS `insert` di atas tetep berlaku normal. RPC di sini murni buat atomicity, bukan buat bypass keamanan.

### `create_journal_entry` — bikin entry baru

```sql
create function create_journal_entry(
  p_entry_date date,
  p_description text,
  p_source_ref text,
  p_lines jsonb -- array of {"account_id": uuid, "debit": numeric, "credit": numeric}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_line jsonb;
begin
  insert into journal_entries (entry_date, description, source_ref, created_by)
  values (p_entry_date, p_description, p_source_ref, auth.uid())
  returning id into v_entry_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into journal_lines (journal_entry_id, account_id, debit, credit)
    values (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      coalesce((v_line->>'debit')::numeric, 0),
      coalesce((v_line->>'credit')::numeric, 0)
    );
  end loop;

  return v_entry_id;
end;
$$;
```

### `reverse_journal_entry` — bikin entry pembalik

Baca semua baris entry asli, bikin entry baru dengan debit/kredit ketuker, link balik lewat `reverses_entry_id`. Ini satu-satunya cara "koreksi" yang disediain — gak ada jalur buat edit entry lama.

```sql
create function reverse_journal_entry(
  p_original_entry_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_new_entry_id uuid;
begin
  insert into journal_entries (entry_date, description, source_ref, reverses_entry_id, created_by)
  select p_entry_date, 'Reversal of ' || je.id, p_source_ref, je.id, auth.uid()
  from journal_entries je where je.id = p_original_entry_id
  returning id into v_new_entry_id;

  insert into journal_lines (journal_entry_id, account_id, debit, credit)
  select v_new_entry_id, jl.account_id, jl.credit, jl.debit -- ketuker
  from journal_lines jl where jl.journal_entry_id = p_original_entry_id;

  return v_new_entry_id;
end;
$$;
```

## RLS Policy

**`journal_entries_select` & `journal_lines_select`** — semua yang `authenticated` boleh liat, sama kayak `accounts_select`: data ledger itu referensi bareng, semua role butuh liat buat kerja/lapor.

**`journal_entries_insert` & `journal_lines_insert`** — cuma `admin`/`accountant` (subquery ke `user_roles`), pola sama persis kayak `accounts_insert`.

**Sengaja gak ada policy `UPDATE`/`DELETE`** — RLS default deny + trigger `block_edit_delete` = 2 lapis proteksi immutability (constraint domain #4).

```sql
alter table journal_entries enable row level security;

create policy journal_entries_select on journal_entries
  for select using (auth.role() = 'authenticated');

create policy journal_entries_insert on journal_entries
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table journal_lines enable row level security;

create policy journal_lines_select on journal_lines
  for select using (auth.role() = 'authenticated');

create policy journal_lines_insert on journal_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny
```

## Grant

Sama kayak yang ketemu di `coa-schema.md` migration 0002 — "Automatically expose new tables" dimatikan di project settings, jadi tabel baru butuh grant eksplisit sebelum RLS-nya bisa "kepakai" sama sekali oleh PostgREST.

```sql
grant select, insert on journal_entries to authenticated;
grant select, insert on journal_lines to authenticated;
```

Period closing (kunci entry per rentang waktu + closing entry ke `Laba Ditahan`) dan rollup saldo per akun (Trial Balance/Neraca) udah dibangun di Fase 7 — lihat `memory/architecture/data/financial-reports-schema.md`. Dampak balik ke modul ini: trigger `journal_entries_block_retroactive_into_closed_period` (ditambah migration `0016_period_closing.sql`) nolak `insert` baru ke `journal_entries` yang `entry_date`-nya jatuh di rentang yang udah tercatat di `period_closings`.
