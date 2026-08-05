-- Fase 3 (AR) lanjutan — Batas Hari Retur per Customer (trade-term komersial), snapshot ke
-- invoice, pola sama persis due_date dari payment_term_days.
--
-- Beda dari items.return_window_days (0021, udah ada) yang soal SIFAT FISIK barang
-- (roti cepat basi vs kue kering awet) — kolom ini soal TOLERANSI DAGANG yang disepakati
-- ke 1 customer (sama axis-nya kayak payment_term_days/credit_limit/overdue_threshold_days
-- yang udah ada di customers). Keduanya COEXIST, bukan saling gantiin:
--   - Jalur full (ada item_id): dicek DUA-duanya — item's window (trigger
--     inventory_return_lines_guard, gak berubah) DAN invoice's window (baru, di bawah).
--     Retur ditolak kalau SALAH SATU kelewat (pola sama credit hold: OR-to-reject).
--   - Jalur financial-only (gak ada item_id): cuma dicek invoice's window — ini juga yang
--     nutup gap nyata: sebelum migration ini, jalur financial-only sama sekali gak ada
--     batas waktu retur.
--
-- Ref bisnis: docs/domain/accounts-receivable.md bagian "Retur Barang" (revisi).

-- ============================================================
-- customers.return_window_days — master data, nullable, NULL = gak dibatasi (biar
-- customer existing gak otomatis kena batas begitu migration ini diapply, pola sama
-- credit_limit/overdue_threshold_days).
-- ============================================================

alter table customers
  add column return_window_days int check (return_window_days is null or return_window_days > 0);

-- ============================================================
-- ar_invoices.return_window_days — SNAPSHOT dari customers.return_window_days pas invoice
-- dibuat, bukan generated column dinamis. Pola sama due_date: kalau
-- customers.return_window_days diubah belakangan, invoice lama gak ikut berubah.
-- ============================================================

alter table ar_invoices
  add column return_window_days int check (return_window_days is null or return_window_days > 0);

-- ============================================================
-- create_ar_invoice (0007, di-extend 0020/0024/0027/0029/0031) — signature GAK BERUBAH
-- (gak ada parameter baru, return_window_days diambil dari customers seperti
-- payment_term_days, bukan input caller) — snapshot return_window_days customer ke kolom
-- baru di ar_invoices, sama langkah yang udah ada buat due_date.
-- ============================================================
create or replace function create_ar_invoice(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_receivable_account_id uuid,
  p_revenue_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_return_window_days int;
  v_entry_id uuid;
  v_invoice_id uuid;
  v_credit_limit numeric;
  v_overdue_threshold_days int;
  v_outstanding numeric;
  v_max_overdue_days int;
begin
  select payment_term_days, credit_limit, overdue_threshold_days, return_window_days
    into v_term_days, v_credit_limit, v_overdue_threshold_days, v_return_window_days
    from customers where id = p_customer_id;
  v_due_date := p_invoice_date + v_term_days;

  select coalesce(sum(greatest(r.remaining, 0)), 0),
         coalesce(max(p_invoice_date - ai.due_date), 0)
    into v_outstanding, v_max_overdue_days
    from ar_invoices ai
    cross join lateral (select ar_invoice_remaining(ai.id) as remaining) r
    where ai.customer_id = p_customer_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ai.journal_entry_id
      )
      and r.remaining > 0;

  if v_credit_limit is not null and (v_outstanding + p_amount) > v_credit_limit then
    raise exception 'Customer kena credit hold: piutang outstanding % + invoice baru % ngelewatin credit_limit %',
      v_outstanding, p_amount, v_credit_limit;
  end if;

  if v_overdue_threshold_days is not null and v_max_overdue_days > v_overdue_threshold_days then
    raise exception 'Customer kena credit hold: ada piutang telat % hari (toleransi % hari)',
      v_max_overdue_days, v_overdue_threshold_days;
  end if;

  v_entry_id := create_journal_entry(
    p_invoice_date, p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_revenue_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_invoices (
    customer_id, invoice_date, due_date, description, source_ref, amount,
    journal_entry_id, return_window_days, created_by
  )
  values (
    p_customer_id, p_invoice_date, v_due_date, p_description, p_source_ref, p_amount,
    v_entry_id, v_return_window_days, auth.uid()
  )
  returning id into v_invoice_id;

  return v_invoice_id;
end;
$$;

-- ============================================================
-- create_ar_credit_note (0021, bugfix 0022, di-extend 0031) — signature GAK BERUBAH (gak
-- nambah parameter). Nambah 1 cek di PALING AWAL fungsi (sebelum bikin jurnal apa pun,
-- fail-fast pola sama credit hold) — kalau ar_invoices.return_window_days invoice ini
-- gak null dan retur udah ngelewatin itu, tolak. Item-level check (inventory_return_lines_guard,
-- 0021) tetap gak disentuh — 2 cek independen, keduanya harus lolos.
-- ============================================================
create or replace function create_ar_credit_note(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null, -- array of {"item_id":uuid,"qty_returned":numeric}
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_invoice_date date;
  v_return_window_days int;
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
  v_remaining_before numeric;
  v_excess numeric;
  v_customer_id uuid;
  v_return_credit_entry_id uuid;
begin
  select invoice_date, return_window_days into v_invoice_date, v_return_window_days
    from ar_invoices where id = p_invoice_id;

  if v_return_window_days is not null and (p_credit_note_date - v_invoice_date) > v_return_window_days then
    raise exception 'Retur invoice % ditolak: toleransi retur customer ini % hari (invoice %, retur diajukan %, telat % hari dari batas)',
      p_invoice_id, v_return_window_days, v_invoice_date, p_credit_note_date,
      (p_credit_note_date - v_invoice_date) - v_return_window_days;
  end if;

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
        values (v_item_id, 'SALES_RETURN', v_credit_note_id, v_qty_returned, v_unit_cost, p_credit_note_date);
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
