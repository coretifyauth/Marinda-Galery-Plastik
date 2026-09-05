-- Gabung ar_return_credits+ap_return_credits (+refunds masing-masing) jadi 2 tabel
-- generic: return_credits, return_credit_refunds. Fase 4 (TERAKHIR) dari unifikasi
-- tabel anak AR/AP -- payments (0069), credit_notes (0070), deposits (0071), sekarang
-- return_credits. RPC refund_ar_return_credit/refund_ap_return_credit DIGABUNG jadi 1
-- (near-exact mirror, pola payments/deposits) -- return_credits sendiri gak pernah
-- punya RPC "create" terpisah, selalu insert inline dari dalam
-- create_ar_credit_note/create_ap_credit_note (TETAP 2 fungsi, gak berubah dari 0070).

-- 1. Tabel return_credits
create table return_credits (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  counterparty_id uuid not null references counterparties(id),
  credit_note_id uuid not null references credit_notes(id),
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

insert into return_credits (id, type, counterparty_id, credit_note_id, amount, journal_entry_id, created_by, created_at)
select id, 'INBOUND', customer_id, credit_note_id, amount, journal_entry_id, created_by, created_at from ar_return_credits
union all
select id, 'OUTBOUND', supplier_id, credit_note_id, amount, journal_entry_id, created_by, created_at from ap_return_credits;

-- 2. Tabel return_credit_refunds
create table return_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references return_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index return_credit_refunds_credit_id_idx on return_credit_refunds(credit_id);
create index return_credits_credit_note_id_idx on return_credits(credit_note_id);
create index return_credits_counterparty_id_idx on return_credits(counterparty_id);

-- Sapu index yang ketinggalan dari fase 2 (credit_notes) & fase 3 (deposits) -- ketauan
-- schema-reviewer pas review migration ini: tabel asal (ar_credit_notes/ap_credit_notes,
-- ar_deposits/ap_deposits) masing-masing punya index journal_entry_id (dan
-- customer_id/supplier_id buat deposits) yang gak ke-bawa pas digabung. ar_invoice_remaining/
-- ap_bill_remaining/recompute_transaction_status manggil tabel-tabel ini di HAMPIR SETIAP
-- write AR/AP, jadi index yang ilang beneran kepakai, bukan cuma kerapian.
create index credit_notes_journal_entry_id_idx on credit_notes(journal_entry_id);
create index deposits_counterparty_id_idx on deposits(counterparty_id);
create index deposits_journal_entry_id_idx on deposits(journal_entry_id);

insert into return_credit_refunds (id, credit_id, amount, source_ref, journal_entry_id, created_by, created_at)
select id, credit_id, amount, source_ref, journal_entry_id, created_by, created_at from ar_return_credit_refunds
union all
select id, credit_id, amount, source_ref, journal_entry_id, created_by, created_at from ap_return_credit_refunds;

-- 3. Trigger return_credits: immutability + type-safety counterparty
create trigger return_credits_block_edit_delete
  before update or delete on return_credits
  for each row execute function block_edit_delete();

create trigger return_credits_counterparty_role_guard_inbound
  before insert on return_credits
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create trigger return_credits_counterparty_role_guard_outbound
  before insert on return_credits
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

-- 4. Guard konsistensi: return_credits.type wajib sama dengan credit_notes.type
-- (kolom type di sini redundan/denormalisasi, sama alasan payments.type/credit_notes.type)
create function return_credits_type_matches_credit_note() returns trigger as $$
declare
  v_credit_note_type text;
begin
  select type into v_credit_note_type from credit_notes where id = new.credit_note_id;
  if v_credit_note_type is distinct from new.type then
    raise exception 'return_credits.type (%) gak cocok sama credit_notes.type (%) buat credit_note_id %', new.type, v_credit_note_type, new.credit_note_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger return_credits_type_matches_credit_note_trigger
  before insert on return_credits
  for each row execute function return_credits_type_matches_credit_note();

-- 5. Sync status transaksi -- gantiin ar_return_credits_sync_invoice_status + ap_return_credits_sync_bill_status
-- (return_credits nambah reducer add-back di ar_invoice_remaining/ap_bill_remaining,
-- jadi insert baris baru di sini juga mancing recompute transaksi asalnya)
create function return_credits_sync_transaction_status() returns trigger as $$
declare
  v_transaction_id uuid;
begin
  select transaction_id into v_transaction_id from credit_notes where id = new.credit_note_id;
  if v_transaction_id is not null then
    perform recompute_transaction_status(v_transaction_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger return_credits_sync_transaction_status_trigger
  after insert on return_credits
  for each row execute function return_credits_sync_transaction_status();

-- 6. return_credit_remaining(credit_id) -- gantiin ar_return_credit_remaining + ap_return_credit_remaining
-- Reducer warranty_replacements.return_credit_settled_amount cuma relevan baris AR HISTORIS
-- (pra-0057) -- disertakan tanpa branch by type karena buat baris OUTBOUND (AP) subquery-nya
-- otomatis 0 (warranty_replacements gak pernah nunjuk credit_note OUTBOUND).
create function return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((
        select sum(wr.return_credit_settled_amount)
        from warranty_replacements wr
        where wr.credit_note_id = c.credit_note_id
      ), 0)
    - coalesce((select sum(amount) from return_credit_refunds where credit_id = p_credit_id), 0)
  from return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

-- 7. Trigger return_credit_refunds: immutability + guard (gak ada sync-status -- refund gak
-- ngubah outstanding invoice/bill asalnya, cuma disposisi surplus)
create trigger return_credit_refunds_block_edit_delete
  before update or delete on return_credit_refunds
  for each row execute function block_edit_delete();

create function return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_credit_note_ref text;
begin
  select return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    select acn.source_ref into v_credit_note_ref
      from return_credits rc join credit_notes acn on acn.id = rc.credit_note_id
      where rc.id = new.credit_id;
    raise exception 'Refund saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba refund %)',
      v_credit_note_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger return_credit_refunds_guard_trigger
  before insert on return_credit_refunds
  for each row execute function return_credit_refunds_guard();

-- 8. RLS & Grant
alter table return_credits enable row level security;
alter table return_credit_refunds enable row level security;

create policy return_credits_select on return_credits for select using (auth.role() = 'authenticated');
create policy return_credits_insert on return_credits for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

create policy return_credit_refunds_select on return_credit_refunds for select using (auth.role() = 'authenticated');
create policy return_credit_refunds_insert on return_credit_refunds for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

grant select, insert on return_credits to authenticated;
grant select, insert on return_credit_refunds to authenticated;

-- 9. RPC generic, gantiin refund_ar_return_credit + refund_ap_return_credit
create function refund_return_credit(
  p_credit_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_return_credit_account_id uuid, -- INBOUND: Saldo Kredit Retur Customer (liability), OUTBOUND: Piutang Retur Supplier (asset)
  p_cash_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_entry_id uuid;
  v_refund_id uuid;
begin
  select type into v_type from return_credits where id = p_credit_id;

  if v_type = 'INBOUND' then
    v_entry_id := create_journal_entry(
      p_entry_date, 'Refund saldo kredit retur customer', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_return_credit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_entry_date, 'Refund saldo kredit retur supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_return_credit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into return_credit_refunds (credit_id, amount, source_ref, journal_entry_id, created_by)
  values (p_credit_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

drop function if exists refund_ar_return_credit(uuid, numeric, date, text, uuid, uuid);
drop function if exists refund_ap_return_credit(uuid, numeric, date, text, uuid, uuid);

-- 10. create_ar_credit_note/create_ap_credit_note: insert target ar_return_credits/ap_return_credits -> return_credits(type)
create or replace function create_ar_credit_note(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null,
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null,
  p_loss_expense_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_goods_issue_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_qty_issued numeric;
  v_total_cost numeric;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_condition text;
  v_total_cost_returned numeric := 0;
  v_total_cost_resalable numeric := 0;
  v_total_cost_damaged numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_hpp_entry_id uuid;
  v_hpp_journal_lines jsonb := '[]'::jsonb;
  v_return_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_conditions text[] := '{}';
  i int;
  v_remaining_before numeric;
  v_excess numeric;
  v_customer_id uuid;
  v_return_credit_entry_id uuid;
  v_line_id uuid;
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining_before;

  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into credit_notes (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('INBOUND', p_invoice_id, p_credit_note_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  v_excess := greatest(0, p_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_liability_account_id is null then
      raise exception 'Retur % bikin outstanding invoice jadi minus (excess %) — wajib isi p_return_credit_liability_account_id',
        p_source_ref, v_excess;
    end if;

    select counterparty_id into v_customer_id from transactions where id = p_invoice_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Saldo kredit dari retur', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into return_credits (type, counterparty_id, credit_note_id, amount, journal_entry_id, created_by)
    values ('INBOUND', v_customer_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_goods_issue_id from goods_issues where invoice_id = p_invoice_id;

    if v_goods_issue_id is null then
      raise exception 'Invoice % gak punya goods_issue — gak bisa retur stok/HPP', p_invoice_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;
      v_condition := coalesce(v_line->>'condition', 'RESALABLE');

      if v_condition not in ('RESALABLE', 'DAMAGED') then
        raise exception 'condition % gak valid -- harus RESALABLE atau DAMAGED', v_condition;
      end if;

      select qty_issued, total_cost into v_qty_issued, v_total_cost
        from goods_issue_lines
        where goods_issue_id = v_goods_issue_id and item_id = v_item_id;

      if not found then
        raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', v_item_id, v_goods_issue_id;
      end if;

      v_unit_cost := v_total_cost / v_qty_issued;
      v_line_cost := v_qty_returned * v_unit_cost;
      v_total_cost_returned := v_total_cost_returned + v_line_cost;

      if v_condition = 'RESALABLE' then
        v_total_cost_resalable := v_total_cost_resalable + v_line_cost;

        select qty_on_hand, avg_cost into v_qty_before, v_avg_before
          from inventory_balances where item_id = v_item_id;

        update inventory_balances
          set qty_on_hand = v_qty_before + v_qty_returned,
              avg_cost = (v_qty_before * v_avg_before + v_qty_returned * v_unit_cost) / (v_qty_before + v_qty_returned),
              updated_at = now()
          where item_id = v_item_id;
      else
        v_total_cost_damaged := v_total_cost_damaged + v_line_cost;
      end if;

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
      v_line_conditions := array_append(v_line_conditions, v_condition);
    end loop;

    if v_total_cost_damaged > 0 and p_loss_expense_account_id is null then
      raise exception 'Ada baris retur DAMAGED (total cost %) -- wajib isi p_loss_expense_account_id',
        v_total_cost_damaged;
    end if;

    if v_total_cost_resalable > 0 then
      v_hpp_journal_lines := v_hpp_journal_lines ||
        jsonb_build_object('account_id', p_finished_good_account_id, 'debit', v_total_cost_resalable, 'credit', 0);
    end if;

    if v_total_cost_damaged > 0 then
      v_hpp_journal_lines := v_hpp_journal_lines ||
        jsonb_build_object('account_id', p_loss_expense_account_id, 'debit', v_total_cost_damaged, 'credit', 0);
    end if;

    v_hpp_journal_lines := v_hpp_journal_lines ||
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', 0, 'credit', v_total_cost_returned);

    v_hpp_entry_id := create_journal_entry(
      p_credit_note_date, 'Reversal HPP retur', p_source_ref, v_hpp_journal_lines
    );

    insert into inventory_returns (credit_note_id, goods_issue_id, journal_entry_id, return_date, source_ref, created_by)
    values (v_credit_note_id, v_goods_issue_id, v_hpp_entry_id, p_credit_note_date, p_source_ref, auth.uid())
    returning id into v_return_id;

    for i in 1..array_length(v_line_items, 1) loop
      insert into inventory_return_lines (inventory_return_id, item_id, qty_returned, total_cost, condition)
      values (v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_conditions[i])
      returning id into v_line_id;

      if v_line_conditions[i] = 'RESALABLE' then
        insert into inventory_movements (item_id, movement_date, qty, inventory_return_line_id)
        values (v_line_items[i], p_credit_note_date, v_line_qtys[i], v_line_id);
      end if;
    end loop;
  end if;

  return v_credit_note_id;
end;
$$;

create or replace function create_ap_credit_note(
  p_bill_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_payable_account_id uuid,
  p_credit_account_id uuid,
  p_lines jsonb default null,
  p_return_credit_asset_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining_before numeric;
  v_effective_amount numeric;
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_grn_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_line_cost numeric;
  v_total_cost_returned numeric := 0;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_excess numeric;
  v_supplier_id uuid;
  v_return_credit_entry_id uuid;
  v_line_id uuid;
begin
  select ap_bill_remaining(p_bill_id) into v_remaining_before;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

    if v_grn_id is null then
      raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok', p_bill_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;

      v_line_cost := consume_weighted_average(v_item_id, v_qty_returned);

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
      v_total_cost_returned := v_total_cost_returned + v_line_cost;
    end loop;

    v_effective_amount := v_total_cost_returned;
  else
    v_effective_amount := p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang ke supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', v_effective_amount, 'credit', 0),
      jsonb_build_object('account_id', p_credit_account_id, 'debit', 0, 'credit', v_effective_amount)
    )
  );

  insert into credit_notes (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('OUTBOUND', p_bill_id, p_credit_note_date, p_source_ref, v_effective_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  if array_length(v_line_items, 1) is not null then
    for i in 1..array_length(v_line_items, 1) loop
      insert into purchase_return_lines (credit_note_id, item_id, qty_returned, total_cost)
      values (v_credit_note_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
      returning id into v_line_id;

      insert into inventory_movements (item_id, movement_date, qty, purchase_return_line_id)
      values (v_line_items[i], p_credit_note_date, -v_line_qtys[i], v_line_id);
    end loop;
  end if;

  v_excess := greatest(0, v_effective_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_asset_account_id is null then
      raise exception 'Retur % bikin Utang Usaha jadi minus (excess %) -- wajib isi p_return_credit_asset_account_id',
        p_source_ref, v_excess;
    end if;

    select counterparty_id into v_supplier_id from transactions where id = p_bill_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Piutang retur dari supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_return_credit_asset_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into return_credits (type, counterparty_id, credit_note_id, amount, journal_entry_id, created_by)
    values ('OUTBOUND', v_supplier_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  return v_credit_note_id;
end;
$$;

-- 11. ar_invoice_remaining/ap_bill_remaining: reducer add-back -> target return_credits
create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from payments where transaction_id = p_invoice_id and type = 'INBOUND'
      ), 0)
    - coalesce((
        select sum(amount) from credit_notes where transaction_id = p_invoice_id and type = 'INBOUND'
      ), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join credit_notes acn on acn.id = rc.credit_note_id
        where acn.transaction_id = p_invoice_id
      ), 0)
    + coalesce((
        select sum(wr.discount_reversed_amount - wr.return_credit_settled_amount)
        from warranty_replacements wr
        join credit_notes cn on cn.id = wr.credit_note_id
        where cn.transaction_id = p_invoice_id
      ), 0)
  from transactions ai
  where ai.id = p_invoice_id;
$$ language sql stable;

create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from payments where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((select sum(amount) from credit_notes where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join credit_notes acn on acn.id = rc.credit_note_id
        where acn.transaction_id = p_bill_id
      ), 0)
  from transactions ab
  where ab.id = p_bill_id;
$$ language sql stable;

-- 12. warranty_replacements_no_over_settle_return_credit: lookup ar_return_credits -> return_credits
create or replace function warranty_replacements_no_over_settle_return_credit() returns trigger as $$
declare
  v_credit_id uuid;
  v_remaining numeric;
  v_credit_note_ref text;
begin
  if new.return_credit_settled_amount = 0 then
    return new;
  end if;

  select id into v_credit_id from return_credits where credit_note_id = new.credit_note_id;

  if v_credit_id is null then
    select source_ref into v_credit_note_ref from credit_notes where id = new.credit_note_id;
    raise exception 'Retur % gak punya saldo kredit retur aktif — gak bisa isi return_credit_settled_amount', v_credit_note_ref;
  end if;

  select return_credit_remaining(v_credit_id) into v_remaining;

  if new.return_credit_settled_amount > v_remaining then
    select acn.source_ref into v_credit_note_ref
      from return_credits rc join credit_notes acn on acn.id = rc.credit_note_id
      where rc.id = v_credit_id;
    raise exception 'Penyelesaian saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba selesaikan %)',
      v_credit_note_ref, v_remaining, new.return_credit_settled_amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- 13. Drop tabel lama (cascade trigger/index/RLS/grant) + fungsi trigger/remaining yang jadi orphan
drop table if exists ar_return_credit_refunds;
drop table if exists ap_return_credit_refunds;
drop table if exists ar_return_credits;
drop table if exists ap_return_credits;

drop function if exists ar_return_credit_remaining(uuid);
drop function if exists ap_return_credit_remaining(uuid);
drop function if exists ar_return_credit_refunds_guard();
drop function if exists ap_return_credit_refunds_guard();
drop function if exists ar_return_credits_sync_invoice_status();
drop function if exists ap_return_credits_sync_bill_status();
