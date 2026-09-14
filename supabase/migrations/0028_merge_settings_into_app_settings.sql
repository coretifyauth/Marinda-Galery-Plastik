-- Ref: docs/architecture/app-settings-schema.md
-- Gabung tax_settings (0006) + company_settings (0009) + pos_settings (0024) jadi 1 tabel
-- singleton -- 3-3nya sama persis pola (id boolean pk default true, RLS select
-- authenticated/update admin), cuma beda domain kolom, gak ada bentrok nama kolom.

create table app_settings (
  id boolean primary key default true check (id),
  -- kolom asal company_settings
  name text not null,
  address text,
  npwp text,
  logo_url text,
  -- kolom asal tax_settings
  is_active boolean not null default false,
  ppn_rate numeric(5,2) not null default 11,
  ppn_keluaran_account_id uuid references accounts(id),
  ppn_masukan_account_id uuid references accounts(id),
  -- kolom asal pos_settings
  walk_in_customer_id uuid not null references counterparties(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

comment on column app_settings.is_active is 'Status wajib pungut PPN (PKP) -- domain tax_settings asal';
comment on column app_settings.walk_in_customer_id is 'Fallback customer "Pelanggan Umum" buat POS -- domain pos_settings asal';

insert into app_settings (
  id, name, address, npwp, logo_url,
  is_active, ppn_rate, ppn_keluaran_account_id, ppn_masukan_account_id,
  walk_in_customer_id, updated_at, updated_by
)
select
  true, cs.name, cs.address, cs.npwp, cs.logo_url,
  ts.is_active, ts.ppn_rate, ts.ppn_keluaran_account_id, ts.ppn_masukan_account_id,
  ps.walk_in_customer_id,
  greatest(cs.updated_at, ts.updated_at, ps.updated_at),
  coalesce(cs.updated_by, ts.updated_by, ps.updated_by)
from company_settings cs, tax_settings ts, pos_settings ps
where cs.id and ts.id and ps.id;

drop table tax_settings;
drop table company_settings;
drop table pos_settings;

create trigger app_settings_set_updated_at
  before update on app_settings
  for each row execute function set_updated_at();

alter table app_settings enable row level security;

create policy app_settings_select on app_settings
  for select using (auth.role() = 'authenticated');

create policy app_settings_update on app_settings
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, update on app_settings to authenticated;

-- create_transaction (0015) & create_pos_sale (0024) baca tax_settings/pos_settings
-- langsung di body-nya -- drop table di atas gak divalidasi Postgres terhadap isi
-- fungsi plpgsql, jadi wajib create-or-replace ulang di sini (satu-satunya perubahan:
-- nama tabel), atau RPC ini meledak runtime begitu ada PPN/walk-in checkout.
create or replace function create_transaction(
  p_type text,
  p_counterparty_id uuid,
  p_date date,
  p_description text,
  p_source_ref text,
  p_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- BUKAN termasuk PPN
  p_control_account_id uuid,
  p_apply_tax boolean default false,
  p_supplier_document_ref text default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_transaction_id uuid;
  v_line jsonb;
  v_total_amount numeric := 0;
  v_journal_lines jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_counterparty counterparties%rowtype;
  v_due_date date;
  v_ppn_rate numeric;
  v_ppn_account_id uuid;
  v_ppn_amount numeric := 0;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Transaksi butuh minimal 1 baris kategori';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if (v_line->>'amount')::numeric <= 0 then
      raise exception 'Nominal baris harus > 0';
    end if;
    v_total_amount := v_total_amount + (v_line->>'amount')::numeric;
  end loop;

  select * into v_counterparty from counterparties where id = p_counterparty_id;
  v_due_date := p_date + (v_counterparty.payment_term_days || ' days')::interval;

  if p_apply_tax then
    select ppn_rate,
           case when p_type = 'OUTBOUND' then ppn_keluaran_account_id else ppn_masukan_account_id end
      into v_ppn_rate, v_ppn_account_id
      from app_settings where id = true and is_active = true;

    if v_ppn_rate is null or v_ppn_account_id is null then
      raise exception 'PPN belum aktif/diset -- cek Pengaturan Pajak';
    end if;

    v_ppn_amount := round(v_total_amount * v_ppn_rate / 100, 2);
  end if;

  -- baris FIXED (control account, Piutang/Utang) + baris VARIABEL (kategori) + PPN opsional
  v_journal_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', p_control_account_id,
      'debit', case when p_type = 'OUTBOUND' then v_total_amount + v_ppn_amount else 0 end,
      'credit', case when p_type = 'INBOUND' then v_total_amount + v_ppn_amount else 0 end
    )
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_line->>'account_id',
        'debit', case when p_type = 'INBOUND' then (v_line->>'amount')::numeric else 0 end,
        'credit', case when p_type = 'OUTBOUND' then (v_line->>'amount')::numeric else 0 end
      )
    );
  end loop;

  if p_apply_tax then
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_ppn_account_id,
        'debit', case when p_type = 'INBOUND' then v_ppn_amount else 0 end,
        'credit', case when p_type = 'OUTBOUND' then v_ppn_amount else 0 end
      )
    );
  end if;

  v_entry_id := create_journal_entry(p_date, p_description, p_source_ref, v_journal_lines);

  insert into transactions (
    type, counterparty_id, date, due_date, description, source_ref, amount, outstanding,
    origin, supplier_document_ref, journal_entry_id, created_by
  )
  values (
    p_type, p_counterparty_id, p_date, v_due_date, p_description, p_source_ref,
    v_total_amount + v_ppn_amount, v_total_amount + v_ppn_amount,
    'financial_only', p_supplier_document_ref, v_entry_id, auth.uid()
  )
  returning id into v_transaction_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
  end loop;

  if p_apply_tax then
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, v_ppn_account_id, v_ppn_amount, true);
  end if;

  return v_transaction_id;
end;
$$;

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
    select 1 from user_roles ur
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
    from default_account_settings where role_key = 'ar.receivable';
  if v_receivable_account_id is null then
    raise exception 'default_account_settings ar.receivable belum diset -- hubungi admin';
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
