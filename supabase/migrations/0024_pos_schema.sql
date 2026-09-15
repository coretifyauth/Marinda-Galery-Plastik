-- POS / Jualan Eceran. Ref: memory/architecture/data/pos-schema.md.
-- Gak ada tabel POS-khusus -- penjualan kios murni komposisi transactions/goods_notes/payments.
-- Identitas "ini penjualan kios" PURE STRUKTURAL: transaksi OUTBOUND + persis 1
-- goods_notes(type='OUTBOUND') + persis 1 payments lunas penuh + 0 retur/DP.

-- Pelanggan walk-in default ("Pelanggan Umum") + pengaturan lain lintas-modul ada di
-- app_settings (docs/architecture/app-settings-schema.md), bukan tabel khusus POS -- diisi
-- lewat RPC complete_onboarding (submodule "Onboarding"), bukan seed migration.

-- create_pos_sale -- security definer PERTAMA di project, orkestrasi create_goods_issue+
-- record_payment. Role cashier cuma bisa lewat sini.
create function create_pos_sale(
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
    where ur.user_id = auth.uid() and ur.role_name in ('admin', 'cashier')
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

-- void_pos_transaction -- SENGAJA gak generik, guard eksplisit "pola penjualan kios
-- sederhana" (persis 1 goods_notes OUTBOUND + persis 1 payment lunas penuh + 0 retur/DP).
create function void_pos_transaction(
  p_transaction_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_transaction_amount numeric;
  v_transaction_journal_entry_id uuid;
  v_goods_issue_id uuid;
  v_goods_issue_journal_entry_id uuid;
  v_payment_journal_entry_id uuid;
  v_payment_amount numeric;
  v_goods_issue_count int;
  v_payment_count int;
  v_return_count int;
  v_deposit_count int;
  v_already_voided boolean;
  v_new_entry_id uuid;
  v_line record;
begin
  select amount, journal_entry_id into v_transaction_amount, v_transaction_journal_entry_id
    from transactions where id = p_transaction_id and type = 'OUTBOUND';
  if not found then
    raise exception 'Transaksi % bukan penjualan (OUTBOUND)', p_transaction_id;
  end if;

  select count(*) into v_goods_issue_count from goods_notes where transaction_id = p_transaction_id and type = 'OUTBOUND';
  select count(*) into v_payment_count from payments where transaction_id = p_transaction_id and type = 'OUTBOUND';
  select count(*) into v_return_count from returns where transaction_id = p_transaction_id;
  select count(*) into v_deposit_count from deposit_applications where transaction_id = p_transaction_id;

  if v_goods_issue_count != 1 or v_payment_count != 1 or v_return_count > 0 or v_deposit_count > 0 then
    raise exception
      'Transaksi % bukan pola penjualan kios sederhana (wajib persis 1 goods issue + 1 payment lunas penuh, tanpa retur/DP) -- pakai cancel_ar_invoice',
      p_transaction_id;
  end if;

  select id, journal_entry_id into v_goods_issue_id, v_goods_issue_journal_entry_id
    from goods_notes where transaction_id = p_transaction_id and type = 'OUTBOUND';

  select journal_entry_id, amount into v_payment_journal_entry_id, v_payment_amount
    from payments where transaction_id = p_transaction_id and type = 'OUTBOUND';

  if v_payment_amount != v_transaction_amount then
    raise exception
      'Transaksi % -- payment gak melunasi penuh (bayar %, total %) -- pakai cancel_ar_invoice',
      p_transaction_id, v_payment_amount, v_transaction_amount;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_transaction_journal_entry_id
  ) into v_already_voided;

  if v_already_voided then
    raise exception 'Transaksi % udah pernah dibatalkan', p_transaction_id;
  end if;

  perform reverse_journal_entry(v_payment_journal_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_goods_issue_journal_entry_id, p_entry_date, p_source_ref);
  v_new_entry_id := reverse_journal_entry(v_transaction_journal_entry_id, p_entry_date, p_source_ref);

  update inventory_balances ib
    set qty_on_hand = ib.qty_on_hand + agg.qty_issued,
        updated_at = now()
    from (
      select item_id, sum(qty) as qty_issued
      from goods_note_lines
      where goods_note_id = v_goods_issue_id
      group by item_id
    ) agg
    where ib.item_id = agg.item_id;

  for v_line in select id, item_id, qty from goods_note_lines where goods_note_id = v_goods_issue_id loop
    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line.item_id, p_entry_date, v_line.qty, v_line.id);
  end loop;

  return v_new_entry_id;
end;
$$;

-- pos_sales_with_status -- single-source, PURE STRUKTURAL.
create view pos_sales_with_status
  with (security_invoker = true) as
select
  t.id, t.date as sale_date, t.source_ref, t.journal_entry_id as revenue_journal_entry_id,
  t.amount as total,
  case when t.status = 'lunas' then 'normal' else t.status end as status,
  t.counterparty_id as customer_id, c.name as customer_name,
  cash_jl.account_id as cash_account_id, ca.code as cash_account_code, ca.name as cash_account_name
from transactions t
  join goods_notes gi on gi.transaction_id = t.id and gi.type = 'OUTBOUND'
  join payments pay on pay.transaction_id = t.id and pay.type = 'OUTBOUND' and pay.amount = t.amount
  left join journal_lines cash_jl on cash_jl.journal_entry_id = pay.journal_entry_id and cash_jl.debit > 0
  left join counterparties c on c.id = t.counterparty_id
  left join accounts ca on ca.id = cash_jl.account_id
where t.type = 'OUTBOUND'
  and not exists (
    select 1 from goods_notes gi2 where gi2.transaction_id = t.id and gi2.type = 'OUTBOUND' and gi2.id <> gi.id
  )
  and not exists (select 1 from payments p2 where p2.transaction_id = t.id and p2.type = 'OUTBOUND' and p2.id <> pay.id)
  and not exists (select 1 from returns r where r.transaction_id = t.id)
  and not exists (select 1 from deposit_applications da where da.transaction_id = t.id);

grant select on pos_sales_with_status to authenticated;

-- journal_entries_sync_reversal_status -- trigger gabungan di journal_entries, dipakai
-- bareng transactions/deposits/pos_sales. Nyapu semua tabel status begitu ada reversing entry.
create function journal_entries_sync_reversal_status() returns trigger as $$
declare
  v_id uuid;
begin
  if new.reverses_entry_id is null then
    return new;
  end if;

  for v_id in select id from transactions where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;

  for v_id in select transaction_id from deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;
  for v_id in select deposit_id from deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_deposit_status(v_id);
  end loop;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger journal_entries_sync_reversal_status_trigger
  after insert on journal_entries
  for each row execute function journal_entries_sync_reversal_status();

grant execute on function create_pos_sale(date, text, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, boolean) to authenticated;
grant execute on function void_pos_transaction(uuid, date, text) to authenticated;
