-- Journal Entry & General Ledger schema (Fase 2)
-- Ref: docs/architecture/data/journal-entry-schema.md

create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  description text,
  source_ref text not null,
  reverses_entry_id uuid references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

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

-- Trigger: cuma leaf account yang boleh diposting.

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

-- Trigger: SUM(debit)=SUM(credit) dan minimal 2 baris per entry.
-- Deferred sampai COMMIT, karena baris pertama sebuah entry pasti "kelihatan" gak balance
-- sebelum baris pasangannya masuk (RPC create_journal_entry masukin semua baris 1 transaksi).

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

-- Trigger: journal_entries/journal_lines gak pernah bisa diedit/dihapus (jaring kedua
-- selain RLS yang sengaja gak ada policy UPDATE/DELETE). Koreksi cuma via reversing entry.

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

-- Trigger di accounts (Fase 1): published lock, ditunda sampai journal_lines ada.
-- Begitu akun dipakai di journal_lines, code/category/normal_balance/parent_id terkunci.

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

-- Trigger di accounts: cegah akun yang udah keposting diam-diam jadi header
-- lewat child baru (edge case yang ketemu pas desain Fase 2).

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

-- RPC atomik (security invoker -> RLS insert tetap berlaku normal, ini cuma buat atomicity).

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

-- Grant: "Automatically expose new tables" dimatikan di project settings,
-- jadi tabel baru butuh grant eksplisit sebelum RLS bisa kepakai PostgREST.

grant select, insert on journal_entries to authenticated;
grant select, insert on journal_lines to authenticated;

-- RLS

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
