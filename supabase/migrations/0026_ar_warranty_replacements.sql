-- Fase 3 (AR) lanjutan — Penggantian Barang Gratis Pasca-Retur.
-- Ref ERD+DDL humanable: docs/architecture/ar-schema.md.
-- Reuse: create_journal_entry() (0004), consume_fifo()/consume_weighted_average() (0012),
--        block_edit_delete() (0004). 0 perubahan ke ar_credit_notes/inventory_returns/create_goods_issue.

-- ============================================================
-- inventory_lot_consumptions.consumption_type: tambah 'WARRANTY_REPLACEMENT'
-- ============================================================

alter table inventory_lot_consumptions drop constraint if exists inventory_lot_consumptions_consumption_type_check;
alter table inventory_lot_consumptions
  add constraint inventory_lot_consumptions_consumption_type_check
  check (consumption_type in ('PRODUCTION_INPUT', 'SALES_ISSUE', 'WARRANTY_REPLACEMENT'));

-- ============================================================
-- Tabel: warranty_replacements + warranty_replacement_lines
-- ============================================================

create table warranty_replacements (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ar_credit_notes(id),
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index warranty_replacements_credit_note_id_idx on warranty_replacements(credit_note_id);
create index warranty_replacements_journal_entry_id_idx on warranty_replacements(journal_entry_id);

create trigger warranty_replacements_block_edit_delete
  before update or delete on warranty_replacements
  for each row execute function block_edit_delete();

create table warranty_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  warranty_replacement_id uuid not null references warranty_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index warranty_replacement_lines_replacement_id_idx on warranty_replacement_lines(warranty_replacement_id);

create trigger warranty_replacement_lines_block_edit_delete
  before update or delete on warranty_replacement_lines
  for each row execute function block_edit_delete();

-- Guard no-over-replace: qty diganti (akumulasi, per item, per credit note) gak boleh
-- ngelebihin qty yang beneran diretur di credit note itu (inventory_return_lines).
create function warranty_replacement_lines_no_over_replace() returns trigger as $$
declare
  v_credit_note_id uuid;
  v_qty_returned numeric;
  v_qty_already_replaced numeric;
begin
  select wr.credit_note_id into v_credit_note_id
    from warranty_replacements wr where wr.id = new.warranty_replacement_id;

  select coalesce(sum(irl.qty_returned), 0) into v_qty_returned
    from inventory_return_lines irl
    join inventory_returns ir on ir.id = irl.inventory_return_id
    where ir.credit_note_id = v_credit_note_id and irl.item_id = new.item_id;

  if v_qty_returned = 0 then
    raise exception 'Item % gak ada di retur credit note %, gak bisa diganti', new.item_id, v_credit_note_id;
  end if;

  select coalesce(sum(wrl.qty_replaced), 0) into v_qty_already_replaced
    from warranty_replacement_lines wrl
    join warranty_replacements wr2 on wr2.id = wrl.warranty_replacement_id
    where wr2.credit_note_id = v_credit_note_id and wrl.item_id = new.item_id;

  if v_qty_already_replaced + new.qty_replaced > v_qty_returned then
    raise exception 'Penggantian item % melebihi qty retur (diretur %, sudah diganti %, coba ganti %)',
      new.item_id, v_qty_returned, v_qty_already_replaced, new.qty_replaced;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger warranty_replacement_lines_no_over_replace_trigger
  before insert on warranty_replacement_lines
  for each row execute function warranty_replacement_lines_no_over_replace();

-- ============================================================
-- RPC: create_warranty_replacement
-- ============================================================
-- Wajib credit_note jalur full (punya inventory_returns) — dicek eksplisit,
-- gak cuma ngandelin trigger yang jalan belakangan pas insert baris.
create function create_warranty_replacement(
  p_credit_note_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_replacement_id uuid := gen_random_uuid();
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_costing_method text;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
begin
  if not exists (select 1 from inventory_returns where credit_note_id = p_credit_note_id) then
    raise exception 'Credit note % financial-only (gak ada retur fisik) — gak bisa bikin penggantian barang', p_credit_note_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Penggantian barang butuh minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    select costing_method into v_costing_method from items where id = v_item_id;

    if v_costing_method = 'FIFO' then
      v_line_cost := consume_fifo(v_item_id, v_qty, 'WARRANTY_REPLACEMENT', v_replacement_id);
    else
      v_line_cost := consume_weighted_average(v_item_id, v_qty);
    end if;

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Penggantian barang gratis pasca-retur', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into warranty_replacements (id, credit_note_id, replacement_date, source_ref, journal_entry_id, created_by)
  values (v_replacement_id, p_credit_note_id, p_replacement_date, p_source_ref, v_entry_id, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into warranty_replacement_lines (warranty_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_replacement_id;
end;
$$;

-- ============================================================
-- RLS Policy
-- ============================================================

alter table warranty_replacements enable row level security;

create policy warranty_replacements_select on warranty_replacements
  for select using (auth.role() = 'authenticated');

create policy warranty_replacements_insert on warranty_replacements
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table warranty_replacement_lines enable row level security;

create policy warranty_replacement_lines_select on warranty_replacement_lines
  for select using (auth.role() = 'authenticated');

create policy warranty_replacement_lines_insert on warranty_replacement_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di 2 tabel ini -> RLS default deny + block_edit_delete

-- ============================================================
-- Grant
-- ============================================================

grant select, insert on warranty_replacements to authenticated;
grant select, insert on warranty_replacement_lines to authenticated;
