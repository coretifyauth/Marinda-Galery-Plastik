-- Kartu Stok — RPC #2 dari rangkaian bertahap (klaim garansi, jarang terjadi). Lihat
-- memory/architecture/data/inventory-schema.md submodule "Kartu Stok / Riwayat Mutasi per Item"
-- > "Rencana Bertahap".
--
-- Signature TETAP SAMA -- CREATE OR REPLACE aman, gak perlu DROP FUNCTION dulu. Satu-satunya
-- perubahan: tiap baris warranty_replacement_lines yang diinsert sekarang juga diikuti 1 baris
-- inventory_movements (qty negatif -- barang pengganti keluar dari stok ke customer).

create or replace function create_warranty_replacement(
  p_credit_note_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_return_credit_liability_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_replacement_id uuid := gen_random_uuid();
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
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
  v_return_credit_id uuid;
  v_return_credit_remaining numeric;
  v_settlement_amount numeric := 0;
  v_settlement_entry_id uuid := null;
  v_line_id uuid;
begin
  if not exists (select 1 from inventory_returns where credit_note_id = p_credit_note_id) then
    raise exception 'Credit note % financial-only (gak ada retur fisik) — gak bisa bikin penukaran barang', p_credit_note_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Penukaran barang butuh minimal 1 baris item';
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

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;

    select irl.qty_returned, irl.total_cost into v_orig_qty_returned, v_orig_total_cost
      from inventory_return_lines irl
      join inventory_returns ir on ir.id = irl.inventory_return_id
      where ir.credit_note_id = p_credit_note_id and irl.item_id = v_item_id;

    if not found then
      raise exception 'Item % gak ada di retur credit note %, gak bisa ditukar', v_item_id, p_credit_note_id;
    end if;

    v_reversal_share_cost := v_reversal_share_cost + (v_qty * (v_orig_total_cost / v_orig_qty_returned));
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Penukaran barang pasca-retur/garansi', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  v_reversal_amount := round(v_credit_note_amount * v_reversal_share_cost / v_total_returned_cost, 2);

  if v_reversal_amount > 0 then
    -- Cek dulu SEBELUM bikin jurnal apa pun (fail-fast) — kalau credit note ini punya
    -- ar_return_credits aktif, porsi diskon yang mau dibalik gak boleh ngelebihin sisa
    -- saldonya. Sebagian saldo itu bisa aja udah kadung direfund tunai duluan
    -- (refund_ar_return_credit) — duitnya udah beneran keluar dan gak bisa "ditarik balik",
    -- jadi porsi reversal yang ngelebihin sisa saldo ditolak, bukan di-least()-kan diam-diam.
    select id into v_return_credit_id from ar_return_credits where credit_note_id = p_credit_note_id;

    if v_return_credit_id is not null then
      select ar_return_credit_remaining(v_return_credit_id) into v_return_credit_remaining;

      if v_reversal_amount > v_return_credit_remaining then
        raise exception 'Pembalikan diskon retur % (porsi %) melebihi sisa saldo kredit retur (sisa %) — sebagian saldo ini kemungkinan udah direfund tunai duluan, gak bisa direversal penuh lewat penukaran barang. Selesaikan sisa saldo kredit retur yang bentrok dulu, atau kurangi qty yang ditukar di panggilan ini.',
          p_credit_note_id, v_reversal_amount, v_return_credit_remaining;
      end if;

      if p_return_credit_liability_account_id is null then
        raise exception 'Credit note % punya saldo kredit retur aktif (sisa %) — wajib isi p_return_credit_liability_account_id buat settle via barang',
          p_credit_note_id, v_return_credit_remaining;
      end if;

      v_settlement_amount := v_reversal_amount;
    end if;

    v_reversal_entry_id := create_journal_entry(
      p_replacement_date, 'Pembalikan diskon retur — barang ditukar, bukan didiskon', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_reversal_amount, 'credit', 0),
        jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', 0, 'credit', v_reversal_amount)
      )
    );

    if v_settlement_amount > 0 then
      v_settlement_entry_id := create_journal_entry(
        p_replacement_date, 'Penyelesaian saldo kredit retur via barang pengganti', p_source_ref,
        jsonb_build_array(
          jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', v_settlement_amount, 'credit', 0),
          jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', v_settlement_amount)
        )
      );
    end if;
  end if;

  insert into warranty_replacements (
    id, credit_note_id, replacement_date, source_ref, journal_entry_id,
    discount_reversed_amount, discount_reversal_journal_entry_id,
    return_credit_settled_amount, return_credit_settlement_journal_entry_id, created_by
  )
  values (
    v_replacement_id, p_credit_note_id, p_replacement_date, p_source_ref, v_entry_id,
    v_reversal_amount, v_reversal_entry_id,
    v_settlement_amount, v_settlement_entry_id, auth.uid()
  );

  for i in 1..array_length(v_line_items, 1) loop
    insert into warranty_replacement_lines (warranty_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, warranty_replacement_line_id)
    values (v_line_items[i], p_replacement_date, -v_line_qtys[i], v_line_id);
  end loop;

  return v_replacement_id;
end;
$$;
