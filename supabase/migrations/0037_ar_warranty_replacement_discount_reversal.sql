-- Fase 3 (AR) — Perbaikan kompensasi ganda warranty_replacement (memory/scope-debt/ar-warranty-replacement-kompensasi-ganda.md, opsi b).
-- Sebelumnya: create_ar_credit_note kasih diskon (Retur & Potongan Penjualan) DAN create_warranty_replacement
-- kasih barang pengganti gratis untuk retur yang sama -> customer diuntungkan dobel.
-- Sekarang: create_warranty_replacement WAJIB membalikkan diskon yang sudah diberikan, proporsional
-- terhadap cost asal barang yang diretur (proxy nilai, karena ar_credit_notes cuma nyimpen 1 amount
-- total per retur, bukan per baris item) -> net kompensasi customer tetap adil (bayar penuh kalau diganti).

alter table warranty_replacements
  add column discount_reversed_amount numeric(14,2) not null default 0 check (discount_reversed_amount >= 0),
  add column discount_reversal_journal_entry_id uuid references journal_entries(id);

-- Guard: total diskon yang dibalik (akumulasi lintas semua warranty_replacement) gak boleh
-- ngelebihin diskon yang sebenarnya diberikan credit note itu.
create function warranty_replacements_no_over_reverse() returns trigger as $$
declare
  v_credit_note_amount numeric;
  v_already_reversed numeric;
begin
  select amount into v_credit_note_amount from ar_credit_notes where id = new.credit_note_id;

  select coalesce(sum(discount_reversed_amount), 0) into v_already_reversed
    from warranty_replacements where credit_note_id = new.credit_note_id;

  if v_already_reversed + new.discount_reversed_amount > v_credit_note_amount then
    raise exception 'Pembalikan diskon retur melebihi diskon yang diberikan (diskon %, sudah dibalik %, coba balik %)',
      v_credit_note_amount, v_already_reversed, new.discount_reversed_amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger warranty_replacements_no_over_reverse_trigger
  before insert on warranty_replacements
  for each row execute function warranty_replacements_no_over_reverse();

-- ============================================================
-- RPC: create_warranty_replacement — tambah p_contra_revenue_account_id + p_receivable_account_id
-- ============================================================

drop function if exists create_warranty_replacement(uuid, date, text, jsonb, uuid, uuid);

create function create_warranty_replacement(
  p_credit_note_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid
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
  v_reversal_entry_id uuid := null;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_credit_note_amount numeric;
  v_total_returned_cost numeric;
  v_orig_qty_returned numeric;
  v_orig_total_cost numeric;
  v_reversal_share_cost numeric := 0;
  v_reversal_amount numeric;
begin
  if not exists (select 1 from inventory_returns where credit_note_id = p_credit_note_id) then
    raise exception 'Credit note % financial-only (gak ada retur fisik) — gak bisa bikin penggantian barang', p_credit_note_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Penggantian barang butuh minimal 1 baris item';
  end if;

  select amount into v_credit_note_amount from ar_credit_notes where id = p_credit_note_id;

  select coalesce(sum(irl.total_cost), 0) into v_total_returned_cost
    from inventory_return_lines irl
    join inventory_returns ir on ir.id = irl.inventory_return_id
    where ir.credit_note_id = p_credit_note_id;

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

    select irl.qty_returned, irl.total_cost into v_orig_qty_returned, v_orig_total_cost
      from inventory_return_lines irl
      join inventory_returns ir on ir.id = irl.inventory_return_id
      where ir.credit_note_id = p_credit_note_id and irl.item_id = v_item_id;

    if not found then
      raise exception 'Item % gak ada di retur credit note %, gak bisa diganti', v_item_id, p_credit_note_id;
    end if;

    v_reversal_share_cost := v_reversal_share_cost + (v_qty * (v_orig_total_cost / v_orig_qty_returned));
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Penggantian barang gratis pasca-retur', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  v_reversal_amount := round(v_credit_note_amount * v_reversal_share_cost / v_total_returned_cost, 2);

  if v_reversal_amount > 0 then
    v_reversal_entry_id := create_journal_entry(
      p_replacement_date, 'Pembalikan diskon retur — barang diganti, bukan didiskon', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_reversal_amount, 'credit', 0),
        jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', 0, 'credit', v_reversal_amount)
      )
    );
  end if;

  insert into warranty_replacements (
    id, credit_note_id, replacement_date, source_ref, journal_entry_id,
    discount_reversed_amount, discount_reversal_journal_entry_id, created_by
  )
  values (
    v_replacement_id, p_credit_note_id, p_replacement_date, p_source_ref, v_entry_id,
    v_reversal_amount, v_reversal_entry_id, auth.uid()
  );

  for i in 1..array_length(v_line_items, 1) loop
    insert into warranty_replacement_lines (warranty_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_replacement_id;
end;
$$;
