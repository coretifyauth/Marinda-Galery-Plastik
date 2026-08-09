-- Kerugian Barang Rusak (sisi AR) -- ref memory/scope-debt/kerugian-barang-rusak.md.
-- Tiap baris retur jalur full (p_lines) sekarang punya `condition`: RESALABLE (default,
-- perilaku existing -- balik masuk stok) atau DAMAGED (gak balik masuk stok, cost-nya
-- direklasifikasi jadi Beban Kerugian Barang Rusak). Kontra-revenue (Piutang Usaha) gak
-- kepengaruh condition -- customer tetap dapat kompensasi piutang berkurang di kedua kasus.

alter table inventory_return_lines
  add column condition text not null default 'RESALABLE'
    check (condition in ('RESALABLE', 'DAMAGED'));

-- create_ar_credit_note: p_lines sekarang nerima {"item_id":uuid,"qty_returned":numeric,
-- "condition":"RESALABLE"|"DAMAGED"} (condition opsional, default RESALABLE -- backward
-- compatible buat caller lama). Baris RESALABLE restock inventory_balances seperti biasa.
-- Baris DAMAGED SKIP restock, cost-nya masuk Beban Kerugian Barang Rusak (p_loss_expense_
-- account_id, param baru) bukan Persediaan Barang Jadi. Jurnal HPP dibangun dinamis --
-- kalau campuran RESALABLE+DAMAGED, 1 journal entry dengan 3 baris (2 debit + 1 kredit HPP
-- gabungan), tetap 1 entry atomik bukan 2 entry terpisah.
create or replace function create_ar_credit_note(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null, -- array of {"item_id":uuid,"qty_returned":numeric,"condition":text}
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
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining_before;

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

  v_excess := greatest(0, p_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_liability_account_id is null then
      raise exception 'Retur % bikin outstanding invoice jadi minus (excess %) — wajib isi p_return_credit_liability_account_id',
        p_source_ref, v_excess;
    end if;

    select customer_id into v_customer_id from ar_invoices where id = p_invoice_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Saldo kredit dari retur', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into ar_return_credits (customer_id, credit_note_id, amount, journal_entry_id, created_by)
    values (v_customer_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
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
      values (v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_conditions[i]);
    end loop;
  end if;

  return v_credit_note_id;
end;
$$;
