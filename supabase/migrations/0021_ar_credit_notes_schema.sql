-- Fase 3 (AR) lanjutan, digarap bareng Fase 5 (Inventory) — AR Credit Note (retur barang).
-- Ref ERD+DDL humanable: docs/architecture/ar-schema.md, docs/architecture/inventory-schema.md.
-- Reuse: create_journal_entry() (0004), block_edit_delete() (0004), set_updated_at() (0001).
-- 0 perubahan ke ar_invoices/goods_issues/create_ar_invoice/create_goods_issue.

-- ============================================================
-- Kolom baru: batas waktu retur (per item)
-- ============================================================

alter table items
  add column return_window_days int check (return_window_days is null or return_window_days > 0);

-- ============================================================
-- inventory_lots.source_type: tambah 'SALES_RETURN'
-- ============================================================

alter table inventory_lots drop constraint if exists inventory_lots_source_type_check;
alter table inventory_lots
  add constraint inventory_lots_source_type_check
  check (source_type in ('PURCHASE_RECEIPT', 'PRODUCTION_OUTPUT', 'SALES_RETURN'));

-- ============================================================
-- Tabel: ar_credit_notes (AR-side, selalu dibuat tiap retur)
-- ============================================================

create table ar_credit_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references ar_invoices(id),
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_credit_notes_invoice_id_idx on ar_credit_notes(invoice_id);
create index ar_credit_notes_journal_entry_id_idx on ar_credit_notes(journal_entry_id);

create trigger ar_credit_notes_block_edit_delete
  before update or delete on ar_credit_notes
  for each row execute function block_edit_delete();

create function ar_credit_notes_no_over_return() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_already_returned numeric;
begin
  select amount into v_invoice_amount from ar_invoices where id = new.invoice_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from ar_credit_notes where invoice_id = new.invoice_id;

  if v_already_returned + new.amount > v_invoice_amount then
    raise exception 'Retur invoice % melebihi nilai invoice (invoice %, sudah diretur %, coba retur %)',
      new.invoice_id, v_invoice_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_credit_notes_no_over_return_trigger
  before insert on ar_credit_notes
  for each row execute function ar_credit_notes_no_over_return();

-- ============================================================
-- Tabel: inventory_returns + inventory_return_lines (Inventory-side, cuma jalur full)
-- ============================================================

create table inventory_returns (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ar_credit_notes(id),
  goods_issue_id uuid not null references goods_issues(id),
  journal_entry_id uuid not null references journal_entries(id),
  return_date date not null,
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index inventory_returns_credit_note_id_idx on inventory_returns(credit_note_id);
create index inventory_returns_goods_issue_id_idx on inventory_returns(goods_issue_id);

create trigger inventory_returns_block_edit_delete
  before update or delete on inventory_returns
  for each row execute function block_edit_delete();

create table inventory_return_lines (
  id uuid primary key default gen_random_uuid(),
  inventory_return_id uuid not null references inventory_returns(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index inventory_return_lines_return_id_idx on inventory_return_lines(inventory_return_id);

create trigger inventory_return_lines_block_edit_delete
  before update or delete on inventory_return_lines
  for each row execute function block_edit_delete();

-- Guard gabungan: no-over-return (qty gak boleh ngelebihin qty_issued) + batas waktu retur per item.
create function inventory_return_lines_guard() returns trigger as $$
declare
  v_goods_issue_id uuid;
  v_return_date date;
  v_qty_issued numeric;
  v_qty_already_returned numeric;
  v_invoice_date date;
  v_return_window_days int;
begin
  select ir.goods_issue_id, ir.return_date into v_goods_issue_id, v_return_date
    from inventory_returns ir where ir.id = new.inventory_return_id;

  select gil.qty_issued into v_qty_issued
    from goods_issue_lines gil
    where gil.goods_issue_id = v_goods_issue_id and gil.item_id = new.item_id;

  if not found then
    raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', new.item_id, v_goods_issue_id;
  end if;

  select coalesce(sum(irl.qty_returned), 0) into v_qty_already_returned
    from inventory_return_lines irl
    join inventory_returns ir2 on ir2.id = irl.inventory_return_id
    where ir2.goods_issue_id = v_goods_issue_id and irl.item_id = new.item_id;

  if v_qty_already_returned + new.qty_returned > v_qty_issued then
    raise exception 'Retur item % melebihi qty terjual (terjual %, sudah diretur %, coba retur %)',
      new.item_id, v_qty_issued, v_qty_already_returned, new.qty_returned;
  end if;

  select ai.invoice_date into v_invoice_date
    from goods_issues gi join ar_invoices ai on ai.id = gi.invoice_id
    where gi.id = v_goods_issue_id;

  select return_window_days into v_return_window_days from items where id = new.item_id;

  if v_return_window_days is not null and (v_return_date - v_invoice_date) > v_return_window_days then
    raise exception 'Retur item % ditolak — lewat batas waktu retur % hari (invoice %, retur %)',
      new.item_id, v_return_window_days, v_invoice_date, v_return_date;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger inventory_return_lines_guard_trigger
  before insert on inventory_return_lines
  for each row execute function inventory_return_lines_guard();

-- ============================================================
-- RPC: create_ar_credit_note
-- ============================================================
-- p_lines null/kosong -> jalur financial-only (1 jurnal).
-- p_lines terisi -> jalur full (2 jurnal + stok balik), invoice WAJIB punya goods_issue.
create function create_ar_credit_note(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null, -- array of {"item_id":uuid,"qty_returned":numeric}
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null
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
  v_total_cost_returned numeric := 0;
  v_costing_method text;
  v_qty_before numeric;
  v_avg_before numeric;
  v_hpp_entry_id uuid;
  v_return_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
begin
  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_credit_notes (invoice_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values (p_invoice_id, p_credit_note_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_goods_issue_id from goods_issues where invoice_id = p_invoice_id;

    if v_goods_issue_id is null then
      raise exception 'Invoice % gak punya goods_issue — gak bisa retur stok/HPP', p_invoice_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;

      select qty_issued, total_cost into v_qty_issued, v_total_cost
        from goods_issue_lines
        where goods_issue_id = v_goods_issue_id and item_id = v_item_id;

      if not found then
        raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', v_item_id, v_goods_issue_id;
      end if;

      v_unit_cost := v_total_cost / v_qty_issued;
      v_line_cost := v_qty_returned * v_unit_cost;
      v_total_cost_returned := v_total_cost_returned + v_line_cost;

      select costing_method into v_costing_method from items where id = v_item_id;

      if v_costing_method = 'FIFO' then
        insert into inventory_lots (item_id, source_type, source_ref, qty_in, unit_cost, lot_date)
        values (v_item_id, 'SALES_RETURN', p_source_ref, v_qty_returned, v_unit_cost, p_credit_note_date);
      else
        select qty_on_hand, avg_cost into v_qty_before, v_avg_before
          from inventory_balances where item_id = v_item_id;

        update inventory_balances
          set qty_on_hand = v_qty_before + v_qty_returned,
              avg_cost = (v_qty_before * v_avg_before + v_qty_returned * v_unit_cost) / (v_qty_before + v_qty_returned),
              updated_at = now()
          where item_id = v_item_id;
      end if;

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

    insert into inventory_returns (credit_note_id, goods_issue_id, journal_entry_id, return_date, source_ref, created_by)
    values (v_credit_note_id, v_goods_issue_id, v_hpp_entry_id, p_credit_note_date, p_source_ref, auth.uid())
    returning id into v_return_id;

    for i in 1..array_length(v_line_items, 1) loop
      insert into inventory_return_lines (inventory_return_id, item_id, qty_returned, total_cost)
      values (v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
    end loop;
  end if;

  return v_credit_note_id;
end;
$$;

-- ============================================================
-- RLS Policy
-- ============================================================

alter table ar_credit_notes enable row level security;

create policy ar_credit_notes_select on ar_credit_notes
  for select using (auth.role() = 'authenticated');

create policy ar_credit_notes_insert on ar_credit_notes
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table inventory_returns enable row level security;

create policy inventory_returns_select on inventory_returns
  for select using (auth.role() = 'authenticated');

create policy inventory_returns_insert on inventory_returns
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table inventory_return_lines enable row level security;

create policy inventory_return_lines_select on inventory_return_lines
  for select using (auth.role() = 'authenticated');

create policy inventory_return_lines_insert on inventory_return_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di 3 tabel ini -> RLS default deny + block_edit_delete

-- ============================================================
-- Grant
-- ============================================================

grant select, insert on ar_credit_notes to authenticated;
grant select, insert on inventory_returns to authenticated;
grant select, insert on inventory_return_lines to authenticated;
