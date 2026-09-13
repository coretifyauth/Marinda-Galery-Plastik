-- Counterparty. Ref: memory/architecture/data/counterparty-schema.md.
-- Cross-cutting, dipakai AR/AP/Inventory(Orders)/POS. Gabungan customers+suppliers,
-- peran dicatat lewat junction table counterparty_type_mapping (1 pihak boleh berperan
-- customer DAN supplier sekaligus).

create table counterparties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null check (payment_term_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email')
);

comment on column counterparties.created_by is 'Email snapshot saat insert (bukan FK) -- konvensi master data (items/counterparties/accounts/bom), beda dari created_by uuid FK di tabel transaksional sejak 0011+. NULL = data lama / insert di luar jalur aplikasi.';

create trigger counterparties_set_updated_at
  before update on counterparties
  for each row execute function set_updated_at();

create table counterparty_type_mapping (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references counterparties(id),
  role text not null check (role in ('customer', 'supplier')),
  unique (counterparty_id, role)
);

-- counterparty_role_guard() -- generic, TG_ARGV[0]=nama kolom, TG_ARGV[1]=role wajib.
-- Dipasang di banyak tabel transaksional (orders/transactions/payments/deposits/
-- return_credits, sepasang _inbound/_outbound per tabel dibedakan kondisi WHEN pada
-- kolom direction/type). NULL diizinkan lolos (kolom nullable, mis. jalur walk-in).
create function counterparty_role_guard() returns trigger as $$
declare
  v_column_name text := TG_ARGV[0];
  v_required_role text := TG_ARGV[1];
  v_counterparty_id uuid;
begin
  v_counterparty_id := (to_jsonb(new) ->> v_column_name)::uuid;
  if v_counterparty_id is null then
    return new;
  end if;
  if not exists (
    select 1 from counterparty_type_mapping
    where counterparty_id = v_counterparty_id and role = v_required_role
  ) then
    raise exception 'Pihak % bukan % terdaftar -- gak bisa dipakai di sini', v_counterparty_id, v_required_role;
  end if;
  return new;
end;
$$ language plpgsql;

-- create_counterparty -- bikin counterparties + counterparty_type_mapping dalam 1 transaksi
-- (gak ada window baris "yatim" tanpa role).
create function create_counterparty(
  p_name text,
  p_role text,
  p_contact text default null,
  p_payment_term_days integer default 7
) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  if p_role not in ('customer', 'supplier') then
    raise exception 'role harus customer atau supplier, dikasih: %', p_role;
  end if;

  insert into counterparties (name, contact, payment_term_days)
  values (p_name, p_contact, p_payment_term_days)
  returning id into v_id;

  insert into counterparty_type_mapping (counterparty_id, role) values (v_id, p_role);

  return v_id;
end;
$$;

-- delete_counterparty -- Smart Delete, security definer. Hapus counterparty_type_mapping
-- duluan (dianggap konfigurasi peran) di blok yang sama, fallback arsip kalau masih dipakai.
create function delete_counterparty(p_counterparty_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh menghapus counterparty';
  end if;

  begin
    delete from counterparty_type_mapping where counterparty_id = p_counterparty_id;
    delete from counterparties where id = p_counterparty_id;
    return 'deleted';
  exception when foreign_key_violation then
    update counterparties set archived_at = now(), updated_at = now() where id = p_counterparty_id;
    return 'archived';
  end;
end;
$$;

grant execute on function delete_counterparty(uuid) to authenticated;

alter table counterparties enable row level security;

create policy counterparties_select on counterparties
  for select using (auth.role() = 'authenticated');

create policy counterparties_insert on counterparties
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

create policy counterparties_update on counterparties
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at + delete_counterparty() security definer

grant select, insert, update on counterparties to authenticated;

alter table counterparty_type_mapping enable row level security;

create policy counterparty_type_mapping_select on counterparty_type_mapping
  for select using (auth.role() = 'authenticated');

create policy counterparty_type_mapping_insert on counterparty_type_mapping
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );
-- role sekali ditetapkan gak berubah lagi -- gak ada policy UPDATE, delete lewat delete_counterparty()

grant select, insert on counterparty_type_mapping to authenticated;
