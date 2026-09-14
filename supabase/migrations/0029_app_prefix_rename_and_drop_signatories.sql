-- Ref: docs/architecture/coa-schema.md, docs/architecture/app-settings-schema.md
-- Base template hardening (2026-09-14): prefix tabel config/infrastruktur cross-cutting
-- dengan app_ biar gampang dibedain dari tabel domain bisnis pas repo ini di-fork jadi
-- project lain (roles -> app_roles, user_roles -> app_user_roles,
-- default_account_settings -> app_default_account_settings). Sekalian signup_whitelist_roles
-- digabung ke signup_whitelist jadi 1 kolom role_name (invariant "1 whitelist = 1 role"
-- udah lama ditegakkan RPC add_whitelist_entry, sekarang dipaksa NOT NULL di kolom) lalu
-- rename jadi app_user_signup_whitelist. document_signatories dihapus total -- fitur blok
-- tanda tangan cetakan gak dipakai lagi.
--
-- CATATAN TEKNIS: ALTER TABLE RENAME otomatis update semua RLS policy/FK/trigger/view yang
-- nunjuk tabel itu (disimpan sebagai parsed expression by OID, bukan teks) -- TAPI TIDAK
-- otomatis update body function plpgsql (disimpan sebagai teks literal, cuma di-parse pas
-- dieksekusi). Semua fungsi yang body-nya nyebut nama tabel lama di-create-or-replace ulang
-- di bawah (ditemukan lewat scan body semua 102 fungsi di supabase/migrations/*.sql).

-- === roles -> app_roles (0 fungsi perlu diubah -- gak ada RPC yang query tabel ini langsung,
-- cuma jadi FK target) ===
alter table roles rename to app_roles;

-- === user_roles -> app_user_roles ===
alter table user_roles rename to app_user_roles;

-- === signup_whitelist + signup_whitelist_roles -> app_user_signup_whitelist ===
alter table signup_whitelist add column role_name text references app_roles(name);

-- Invariant "1 whitelist = 1 role" cuma pernah dijaga RPC (add_whitelist_entry nolak
-- array >1 elemen), bukan constraint DB -- PK signup_whitelist_roles (whitelist_id,
-- role_name) secara struktural masih izinin >1 baris per whitelist_id (insert manual
-- lewat SQL). UPDATE...FROM di bawah diam-diam milih 1 baris gak terprediksi kalau ada
-- >1 match (bukan error) -- fail loud dulu di sini daripada silent data loss.
do $$
begin
  if exists (
    select 1 from signup_whitelist_roles group by whitelist_id having count(*) > 1
  ) then
    raise exception 'Ada whitelist_id di signup_whitelist_roles dengan >1 role -- backfill role_name bakal ambigu, resolve manual dulu sebelum migration ini jalan lagi';
  end if;
end $$;

update signup_whitelist sw
set role_name = swr.role_name
from signup_whitelist_roles swr
where swr.whitelist_id = sw.id;

alter table signup_whitelist add check (role_name <> 'master');
alter table signup_whitelist alter column role_name set not null;

drop table signup_whitelist_roles;

alter table signup_whitelist rename to app_user_signup_whitelist;

-- === default_account_settings -> app_default_account_settings ===
alter table default_account_settings rename to app_default_account_settings;

-- === document_signatories: dihapus, fitur blok tanda tangan cetakan gak dipakai lagi ===
drop table document_signatories;

-- ============================================================================
-- Create-or-replace fungsi yang body-nya masih nyebut nama tabel lama secara literal.
-- ============================================================================

-- before_user_created_hook (0002) -- signup_whitelist -> app_user_signup_whitelist
create or replace function before_user_created_hook(event jsonb) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
begin
  v_email := lower(event -> 'user' ->> 'email');

  if v_email is null or not exists (
    select 1 from app_user_signup_whitelist sw where sw.email = v_email and sw.consumed_at is null
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Email ini belum diizinkan buat daftar -- hubungi admin buat ditambahkan ke whitelist.'
      )
    );
  end if;

  return jsonb_build_object();
end;
$$;

-- handle_new_user_role_assignment (0002) -- user_roles/signup_whitelist -> tabel baru, plus
-- role_name sekarang kolom langsung (gak perlu select dari join table lagi)
create or replace function handle_new_user_role_assignment() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_whitelist_id uuid;
  v_role_name text;
begin
  select id, role_name into v_whitelist_id, v_role_name
    from app_user_signup_whitelist
    where email = lower(new.email) and consumed_at is null
    for update;

  if v_whitelist_id is null then
    raise exception 'Email % gak ada di whitelist yang masih aktif -- signup seharusnya sudah ditolak hook', new.email;
  end if;

  insert into app_user_roles (user_id, role_name) values (new.id, v_role_name);

  update app_user_signup_whitelist set consumed_at = now() where id = v_whitelist_id;

  return new;
end;
$$;

-- list_app_users (0002) -- user_roles -> app_user_roles
create or replace function list_app_users() returns table (
  user_id uuid, email text, roles text[], user_created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master') then
    raise exception 'Cuma master yang boleh lihat daftar user';
  end if;

  return query
    select u.id, u.email::text, coalesce(array_agg(ur.role_name order by ur.role_name) filter (where ur.role_name is not null), '{}'),
           u.created_at
    from auth.users u
    left join app_user_roles ur on ur.user_id = u.id
    group by u.id, u.email, u.created_at
    order by u.created_at desc;
end;
$$;

-- set_user_roles (0002) -- user_roles -> app_user_roles
create or replace function set_user_roles(p_user_id uuid, p_roles text[]) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master') then
    raise exception 'Cuma master yang boleh ubah role user';
  end if;

  if 'master' = any(p_roles) then
    raise exception 'Role master gak bisa di-assign lewat sini -- harus manual lewat database';
  end if;

  if p_roles is null or array_length(p_roles, 1) is null then
    raise exception 'User harus punya minimal 1 role -- gak bisa dikosongkan lewat sini';
  end if;

  if array_length(p_roles, 1) > 1 then
    raise exception '1 akun cuma boleh punya 1 role (admin ATAU cashier) -- multi-role cuma buat master, harus manual lewat database';
  end if;

  delete from app_user_roles where user_id = p_user_id and role_name <> 'master';
  insert into app_user_roles (user_id, role_name)
    select p_user_id, r from unnest(p_roles) r;
end;
$$;

-- add_whitelist_entry (0002) -- signature diubah dari p_roles text[] ke p_role text
-- (tunggal), ngikutin app_user_signup_whitelist.role_name yang sekarang 1 kolom bukan
-- join table -- overload lama (text, text[]) di-drop biar gak nyangkut jadi dead API.
drop function add_whitelist_entry(text, text[]);

create function add_whitelist_entry(p_email text, p_role text) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master') then
    raise exception 'Cuma master yang boleh kelola whitelist';
  end if;

  if p_role is null then
    raise exception 'Pilih 1 role buat email ini';
  end if;

  if p_role = 'master' then
    raise exception 'Role master gak bisa diberikan lewat whitelist -- harus manual lewat database';
  end if;

  insert into app_user_signup_whitelist (email, role_name) values (lower(p_email), p_role) returning id into v_id;

  return v_id;
end;
$$;

-- remove_whitelist_entry (0002) -- signup_whitelist -> app_user_signup_whitelist
create or replace function remove_whitelist_entry(p_whitelist_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'master') then
    raise exception 'Cuma master yang boleh kelola whitelist';
  end if;

  delete from app_user_signup_whitelist where id = p_whitelist_id and consumed_at is null;
  if not found then
    raise exception 'Undangan gak ditemukan atau sudah dipakai buat signup -- gak bisa dihapus';
  end if;
end;
$$;

grant execute on function add_whitelist_entry(text, text) to authenticated;

-- ensure_master_has_all_roles (0002) -- user_roles -> app_user_roles
create or replace function ensure_master_has_all_roles() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into app_user_roles (user_id, role_name)
  values (new.user_id, 'admin'), (new.user_id, 'cashier')
  on conflict do nothing;
  return new;
end;
$$;

-- delete_account (0003) -- user_roles -> app_user_roles
create or replace function delete_account(p_account_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant')
  ) then
    raise exception 'Cuma admin/accountant yang boleh menghapus akun';
  end if;

  begin
    delete from accounts where id = p_account_id;
    return 'deleted';
  exception when foreign_key_violation then
    update accounts set archived_at = now() where id = p_account_id;
    return 'archived';
  end;
end;
$$;

-- delete_counterparty (0004) -- user_roles -> app_user_roles
create or replace function delete_counterparty(p_counterparty_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from app_user_roles ur
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

-- delete_item (0005) -- user_roles -> app_user_roles
create or replace function delete_item(p_item_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh menghapus item';
  end if;

  begin
    delete from item_units where item_id = p_item_id;
    delete from items where id = p_item_id;
    return 'deleted';
  exception when foreign_key_violation then
    update items set archived_at = now(), updated_at = now() where id = p_item_id;
    return 'archived';
  end;
end;
$$;

-- generate_item_unit_barcode (0005) -- user_roles -> app_user_roles
create or replace function generate_item_unit_barcode(p_unit_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_attempt int := 0;
  v_max_attempts constant int := 20;
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh generate kode scan';
  end if;

  if not exists (select 1 from item_units where id = p_unit_id) then
    raise exception 'Satuan jual tidak ditemukan';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := generate_document_number('item_unit_barcodes');
    begin
      update item_units set barcode = v_code where id = p_unit_id;
      if not found then
        raise exception 'Satuan jual tidak ditemukan atau sudah dihapus';
      end if;
      return v_code;
    exception when unique_violation then
      if v_attempt >= v_max_attempts then
        raise exception 'Gagal generate kode scan unik setelah % percobaan', v_attempt;
      end if;
      -- kode ini hangus (counter sudah maju, gak dipakai baris manapun) -- lanjut loop coba nomor berikutnya
    end;
  end loop;
end;
$$;

-- create_pos_sale (0024, di-create-or-replace lagi di 0028 buat app_settings) --
-- user_roles -> app_user_roles, default_account_settings -> app_default_account_settings
create or replace function create_pos_sale(
  p_sale_date date,
  p_source_ref text,
  p_customer_id uuid,
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_sold":numeric,"unit_price":numeric}
  p_extra_credit_lines jsonb default '[]'::jsonb,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_receivable_account_id uuid;
  v_line jsonb;
  v_qty numeric;
  v_unit_price numeric;
  v_total_amount numeric := 0;
  v_credit_lines jsonb;
  v_issue_lines jsonb := '[]'::jsonb;
  v_goods_issue_id uuid;
  v_transaction_id uuid;
  v_settle_amount numeric;
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin', 'accountant', 'cashier')
  ) then
    raise exception 'Gak punya akses buat bikin POS Sale';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'POS sale wajib punya minimal 1 baris item';
  end if;

  v_customer_id := p_customer_id;
  if v_customer_id is null then
    select walk_in_customer_id into v_customer_id from app_settings where id = true;
    if v_customer_id is null then
      raise exception 'app_settings.walk_in_customer_id belum diset -- hubungi admin';
    end if;
  end if;

  select account_id into v_receivable_account_id
    from app_default_account_settings where role_key = 'ar.receivable';
  if v_receivable_account_id is null then
    raise exception 'app_default_account_settings ar.receivable belum diset -- hubungi admin';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := (v_line ->> 'qty_sold')::numeric;
    v_unit_price := (v_line ->> 'unit_price')::numeric;

    if v_qty <= 0 then
      raise exception 'qty_sold harus > 0';
    end if;
    if v_unit_price < 0 then
      raise exception 'unit_price gak boleh negatif';
    end if;

    v_total_amount := v_total_amount + v_qty * v_unit_price;

    v_issue_lines := v_issue_lines || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_line ->> 'item_id',
        'qty_issued', v_qty,
        'order_line_id', null,
        'unit_price', v_unit_price
      )
    );
  end loop;

  v_credit_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_revenue_account_id, 'amount', v_total_amount)
  );

  if p_extra_credit_lines is not null and jsonb_array_length(p_extra_credit_lines) > 0 then
    for v_line in select * from jsonb_array_elements(p_extra_credit_lines)
    loop
      if (v_line ->> 'amount')::numeric <= 0 then
        raise exception 'Nominal baris biaya tambahan harus > 0';
      end if;
      v_credit_lines := v_credit_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_line ->> 'account_id', 'amount', (v_line ->> 'amount')::numeric)
      );
    end loop;
  end if;

  v_goods_issue_id := create_goods_issue(
    v_customer_id, p_sale_date, 'Penjualan POS', p_source_ref,
    v_credit_lines, v_receivable_account_id,
    v_issue_lines, p_hpp_account_id, p_finished_good_account_id,
    p_apply_tax
  );

  select transaction_id into v_transaction_id from goods_notes where id = v_goods_issue_id;

  select amount into v_settle_amount from transactions where id = v_transaction_id;

  perform record_payment(
    'OUTBOUND', v_customer_id, p_sale_date, v_settle_amount, p_source_ref,
    p_cash_account_id, v_receivable_account_id, v_transaction_id
  );

  return v_transaction_id;
end;
$$;
