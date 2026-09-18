-- Returns (Retur AR + AP, digabung). Ref: memory/architecture/data/returns-schema.md.
-- type='INBOUND' = retur dari customer (AR), type='OUTBOUND' = retur ke supplier (AP).
-- goods_issue_id (return_lines) mereferensikan goods_notes -- tabel itu baru didefinisikan
-- di 0018_goods_notes_schema.sql -- file ini WAJIB nomor setelahnya (FK return_lines.goods_issue_id
-- butuh tabel goods_notes udah ada SAAT CREATE TABLE, beda dari referensi di dalam function
-- body yang lazy-resolved).

create table returns (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  transaction_id uuid not null references transactions(id),
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index returns_transaction_id_idx on returns(transaction_id);

create table return_lines (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  return_id uuid not null references returns(id),
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0),
  condition text not null default 'RESALABLE' check (condition in ('RESALABLE', 'DAMAGED')),
  goods_issue_id uuid references goods_notes(id),
  hpp_reversal_journal_entry_id uuid references journal_entries(id)
);

-- Prasyarat composite FK inventory_movements(return_line_id, item_id) -> ini (WAJIB
-- unique CONSTRAINT, bukan cuma index -- Postgres nolak FK yang nunjuk kolom yang cuma
-- didukung index biasa).
alter table return_lines add constraint return_lines_id_item_id_key unique (id, item_id);
create index return_lines_return_id_idx on return_lines(return_id);

create trigger credit_notes_block_edit_delete
  before update or delete on returns
  for each row execute function block_edit_delete();

create function credit_notes_type_matches_transaction() returns trigger as $$
declare
  v_transaction_type text;
begin
  select type into v_transaction_type from transactions where id = new.transaction_id;
  if v_transaction_type = new.type then
    raise exception 'returns.type (%) harus KEBALIKAN dari transactions.type (%) buat transaction_id % -- retur adalah pembalikan arah, bukan arah yang sama', new.type, v_transaction_type, new.transaction_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger credit_notes_type_matches_transaction_trigger
  before insert on returns
  for each row execute function credit_notes_type_matches_transaction();

create function credit_notes_no_over_return() returns trigger as $$
declare
  v_transaction_amount numeric;
  v_already_returned numeric;
  v_transaction_ref text;
begin
  select amount into v_transaction_amount from transactions where id = new.transaction_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from returns where transaction_id = new.transaction_id;

  if v_already_returned + new.amount > v_transaction_amount then
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Retur % melebihi nilai transaksi (nilai %, sudah diretur %, coba retur %)',
      v_transaction_ref, v_transaction_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger credit_notes_no_over_return_trigger
  before insert on returns
  for each row execute function credit_notes_no_over_return();

create function credit_notes_sync_transaction_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.transaction_id);
  return new;
end;
$$ language plpgsql;

create trigger credit_notes_sync_transaction_status_trigger
  after insert on returns
  for each row execute function credit_notes_sync_transaction_status();

create trigger return_lines_block_edit_delete
  before update or delete on return_lines
  for each row execute function block_edit_delete();

-- return_lines_no_over_return_inbound/outbound -- AR baca goods_issue_id LANGSUNG dari baris
-- itu sendiri (nunjuk goods_notes). AP lookup bill_id lewat returns.transaction_id.
create function return_lines_no_over_return_inbound() returns trigger as $$
declare
  v_invoice_id uuid;
  v_qty_issued numeric;
  v_already_claimed numeric;
begin
  select gn.transaction_id into v_invoice_id
    from goods_notes gn where gn.id = new.goods_issue_id;

  select gnl.qty into v_qty_issued
    from goods_note_lines gnl
    where gnl.goods_note_id = new.goods_issue_id and gnl.item_id = new.item_id;

  if not found then
    raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', new.item_id, new.goods_issue_id;
  end if;

  select sales_returned_qty(v_invoice_id, new.item_id) into v_already_claimed;

  if v_already_claimed + new.qty_returned > v_qty_issued then
    raise exception 'Retur item % melebihi qty terjual dikurangi yang udah diklaim lewat retur/ganti barang (terjual %, udah diklaim %, coba retur %)',
      new.item_id, v_qty_issued, v_already_claimed, new.qty_returned;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger return_lines_no_over_return_inbound_trigger
  before insert on return_lines
  for each row when (new.type = 'INBOUND')
  execute function return_lines_no_over_return_inbound();

create function return_lines_no_over_return_outbound() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
  v_bill_ref text;
  v_item_name text;
begin
  select transaction_id into v_bill_id from returns where id = new.return_id;
  select id into v_grn_id from goods_notes where transaction_id = v_bill_id and type = 'INBOUND';

  if v_grn_id is null then
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Bill % gak punya goods receipt -- gak bisa retur stok per item', v_bill_ref;
  end if;

  select qty into v_qty_received
    from goods_note_lines where goods_note_id = v_grn_id and item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Item "%" gak ada di goods receipt bill %, gak bisa diretur', v_item_name, v_bill_ref;
  end if;

  select purchase_returned_qty(v_bill_id, new.item_id) into v_already;

  if v_already + new.qty_returned > v_qty_received then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Retur item "%" melebihi qty diterima (diterima %, sudah diklaim %, coba retur %)',
      v_item_name, v_qty_received, v_already, new.qty_returned;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger return_lines_no_over_return_outbound_trigger
  before insert on return_lines
  for each row when (new.type = 'OUTBOUND')
  execute function return_lines_no_over_return_outbound();

-- sales_returned_qty/purchase_returned_qty -- gabungan qty yang udah "diklaim" lintas
-- retur+ganti barang (replacements, didefinisikan di file belakangan -- aman, SQL stable
-- function resolve lazy saat dipanggil).
create function sales_returned_qty(p_invoice_id uuid, p_item_id uuid) returns numeric as $$
declare
  v_result numeric;
begin
  select
    coalesce((
      select sum(rl.qty_returned) from return_lines rl
      join returns r on r.id = rl.return_id
      where r.transaction_id = p_invoice_id and rl.type = 'INBOUND' and rl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(rpl.qty_replaced) from replacement_lines rpl
      join replacements rp on rp.id = rpl.replacement_id
      where rp.transaction_id = p_invoice_id and rp.type = 'INBOUND' and rpl.item_id = p_item_id
    ), 0)
  into v_result;
  return v_result;
end;
$$ language plpgsql stable;

create function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
declare
  v_result numeric;
begin
  select
    coalesce((
      select sum(rl.qty_returned) from return_lines rl
      join returns r on r.id = rl.return_id
      where r.transaction_id = p_bill_id and rl.type = 'OUTBOUND' and rl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(rpl.qty_replaced) from replacement_lines rpl
      join replacements rp on rp.id = rpl.replacement_id
      where rp.transaction_id = p_bill_id and rp.type = 'OUTBOUND' and rpl.item_id = p_item_id
    ), 0)
  into v_result;
  return v_result;
end;
$$ language plpgsql stable;

-- create_ar_return/create_ap_return -- TETAP 2 fungsi terpisah (efek jurnal beda bentuk).
-- inventory_movements/goods_note_lines/consume_weighted_average dipanggil di sini --
-- inventory_movements/consume_weighted_average baru didefinisikan 0023, aman (lazy resolve).
create function create_ar_return(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null,
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_return_id uuid;
  v_goods_issue_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_qty_issued numeric;
  v_total_cost numeric;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_total_cost_returned numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_hpp_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
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

  insert into returns (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('INBOUND', p_invoice_id, p_credit_note_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_return_id;

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

    insert into return_credits (type, counterparty_id, return_id, amount, journal_entry_id, created_by)
    values ('INBOUND', v_customer_id, v_return_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_goods_issue_id from goods_notes where transaction_id = p_invoice_id and type = 'OUTBOUND';

    if v_goods_issue_id is null then
      raise exception 'Invoice % gak punya goods issue — gak bisa retur stok/HPP', p_invoice_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;

      select qty, total_cost into v_qty_issued, v_total_cost
        from goods_note_lines
        where goods_note_id = v_goods_issue_id and item_id = v_item_id;

      if not found then
        raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', v_item_id, v_goods_issue_id;
      end if;

      v_unit_cost := v_total_cost / v_qty_issued;
      v_line_cost := v_qty_returned * v_unit_cost;
      v_total_cost_returned := v_total_cost_returned + v_line_cost;

      select qty_on_hand, avg_cost into v_qty_before, v_avg_before
        from inventory_balances where item_id = v_item_id;

      update inventory_balances
        set qty_on_hand = v_qty_before + v_qty_returned,
            avg_cost = (v_qty_before * v_avg_before + v_qty_returned * v_unit_cost) / (v_qty_before + v_qty_returned),
            updated_at = now()
        where item_id = v_item_id;

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
    end loop;

    v_hpp_entry_id := create_journal_entry(
      p_credit_note_date, 'Reversal HPP retur', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_finished_good_account_id, 'debit', v_total_cost_returned, 'credit', 0),
        jsonb_build_object('account_id', p_hpp_account_id, 'debit', 0, 'credit', v_total_cost_returned)
      )
    );

    for i in 1..array_length(v_line_items, 1) loop
      insert into return_lines (type, return_id, item_id, qty_returned, total_cost, goods_issue_id, hpp_reversal_journal_entry_id)
      values ('INBOUND', v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_goods_issue_id, v_hpp_entry_id)
      returning id into v_line_id;

      insert into inventory_movements (item_id, movement_date, qty, return_line_id)
      values (v_line_items[i], p_credit_note_date, v_line_qtys[i], v_line_id);
    end loop;
  end if;

  return v_return_id;
end;
$$;

create function create_ap_return(
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
  v_return_id uuid;
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
    select id into v_grn_id from goods_notes where transaction_id = p_bill_id and type = 'INBOUND';

    if v_grn_id is null then
      raise exception 'Bill % gak punya goods receipt -- gak bisa retur stok', p_bill_id;
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

  insert into returns (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('OUTBOUND', p_bill_id, p_credit_note_date, p_source_ref, v_effective_amount, v_entry_id, auth.uid())
  returning id into v_return_id;

  if array_length(v_line_items, 1) is not null then
    for i in 1..array_length(v_line_items, 1) loop
      insert into return_lines (type, return_id, item_id, qty_returned, total_cost)
      values ('OUTBOUND', v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
      returning id into v_line_id;

      insert into inventory_movements (item_id, movement_date, qty, return_line_id)
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

    insert into return_credits (type, counterparty_id, return_id, amount, journal_entry_id, created_by)
    values ('OUTBOUND', v_supplier_id, v_return_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  return v_return_id;
end;
$$;

alter table returns enable row level security;

create policy returns_select on returns
  for select using (auth.role() = 'authenticated');

create policy returns_insert on returns
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on returns to authenticated;

alter table return_lines enable row level security;

create policy return_lines_select on return_lines
  for select using (auth.role() = 'authenticated');

create policy return_lines_insert on return_lines
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on return_lines to authenticated;
