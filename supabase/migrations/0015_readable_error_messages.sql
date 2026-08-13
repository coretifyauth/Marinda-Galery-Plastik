-- Readable error messages: ganti UUID mentah di raise exception dengan nama/rujukan yang
-- kebaca manusia (nama item, source_ref bill/invoice/deposit/credit note/goods issue, kode
-- akun, nama aset) di seluruh trigger & RPC lintas modul (Journal Entry/Inventory/AP/AR/
-- Fixed Assets/POS) -- diminta user (2026-08-12) setelah nemuin pesan kayak "Stok Weighted
-- Average item c1e00466-d202-4db7-a1b3-83eaaefccb1a gak cukup" yang gak kebaca orang awam.
--
-- Semua `create or replace function` di sini CUMA ganti isi body (nambah lookup + ubah teks
-- pesan) -- signature (nama+urutan+tipe parameter) SAMA PERSIS kayak sebelumnya di semua
-- fungsi, jadi aman lewat create or replace tanpa perlu drop dulu (beda dari kasus di 0011/
-- 0012 yang beneran nambah/ubah parameter -- lihat komentar di situ soal kenapa itu wajib
-- drop duluan).
--
-- Case yang SENGAJA gak diubah: void_pos_sale() pas sale-nya "not found" -- kalau UUID itu
-- sendiri gak ketemu di pos_sales, gak ada apa pun buat di-lookup jadi pengganti yang lebih
-- kebaca (satu-satunya info yang ada ya UUID yang gak valid itu).

-- ============================================================
-- Journal Entry (0003_journal_entry_schema.sql)
-- ============================================================

create or replace function journal_lines_leaf_only() returns trigger as $$
declare
  v_account_code text;
begin
  if exists (select 1 from accounts where parent_id = new.account_id) then
    select code into v_account_code from accounts where id = new.account_id;
    raise exception 'Akun % adalah header (punya child), gak boleh diposting langsung', v_account_code;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function journal_lines_balance_check() returns trigger as $$
declare
  v_entry_id uuid := coalesce(new.journal_entry_id, old.journal_entry_id);
  v_count int;
  v_debit numeric;
  v_credit numeric;
  v_source_ref text;
begin
  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_count, v_debit, v_credit
  from journal_lines where journal_entry_id = v_entry_id;

  select source_ref into v_source_ref from journal_entries where id = v_entry_id;

  if v_count < 2 then
    raise exception 'Journal entry % minimal 2 baris (ada %)', v_source_ref, v_count;
  end if;

  if v_debit <> v_credit then
    raise exception 'Journal entry % gak balance: debit % != kredit %', v_source_ref, v_debit, v_credit;
  end if;

  return null;
end;
$$ language plpgsql;

-- ============================================================
-- Inventory (0004_inventory_schema.sql)
-- ============================================================

create or replace function goods_receipt_lines_no_over_receipt() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_received numeric;
  v_item_name text;
begin
  select qty_ordered into v_qty_ordered from purchase_order_lines where id = new.po_line_id;
  select coalesce(sum(qty_received), 0) into v_qty_received
    from goods_receipt_lines where po_line_id = new.po_line_id;

  if v_qty_received + new.qty_received > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Penerimaan item "%" melebihi qty dipesan (sisa %, coba terima %)',
      v_item_name, v_qty_ordered - v_qty_received, new.qty_received;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function goods_issue_lines_no_over_issue() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_issued numeric;
  v_item_name text;
begin
  if new.so_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from sales_order_lines where id = new.so_line_id;
  select coalesce(sum(qty_issued), 0) into v_qty_issued
    from goods_issue_lines where so_line_id = new.so_line_id;

  if v_qty_issued + new.qty_issued > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Pengiriman item "%" melebihi qty dipesan di Sales Order (sisa %, coba kirim %)',
      v_item_name, v_qty_ordered - v_qty_issued, new.qty_issued;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function consume_weighted_average(p_item_id uuid, p_qty_needed numeric) returns numeric
language plpgsql
security invoker
as $$
declare
  v_qty_on_hand numeric;
  v_avg_cost numeric;
  v_total_cost numeric;
  v_item_name text;
begin
  select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
    from inventory_balances where item_id = p_item_id;

  if not found or v_qty_on_hand < p_qty_needed then
    select name into v_item_name from items where id = p_item_id;
    raise exception 'Stok Weighted Average item "%" gak cukup (tersedia %, butuh %)',
      coalesce(v_item_name, p_item_id::text), coalesce(v_qty_on_hand, 0), p_qty_needed;
  end if;

  v_total_cost := p_qty_needed * v_avg_cost;

  update inventory_balances
    set qty_on_hand = v_qty_on_hand - p_qty_needed,
        updated_at = now()
    where item_id = p_item_id;

  return v_total_cost;
end;
$$;

create or replace function record_stock_opname(
  p_opname_date date,
  p_source_ref text,
  p_lines jsonb,
  p_shortage_expense_account_id uuid,
  p_surplus_revenue_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_opname_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_actual numeric;
  v_inventory_account_id uuid;
  v_qty_system numeric;
  v_avg_cost numeric;
  v_variance numeric;
  v_value numeric;
  v_entry_id uuid;
  v_any_line boolean := false;
  v_item_name text;
begin
  insert into stock_opnames (opname_date, source_ref, created_by)
  values (p_opname_date, p_source_ref, auth.uid())
  returning id into v_opname_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty_actual := (v_line->>'qty_actual')::numeric;
    v_inventory_account_id := (v_line->>'inventory_account_id')::uuid;

    -- for update — kunci baris ini sepanjang transaksi. record_stock_opname melakukan SET
    -- absolut (bukan delta kayak consume_weighted_average/create_goods_receipt), jadi jendela
    -- read-then-write di sini lebih beresiko: sesi opname bisa berlangsung lama sebelum
    -- disubmit, dan transaksi lain (goods receipt/issue/produksi) yang nyelip di antaranya
    -- bakal ketiban timpa diam-diam tanpa error kalau baris ini gak dikunci.
    select qty_on_hand, avg_cost into v_qty_system, v_avg_cost
      from inventory_balances where item_id = v_item_id
      for update;

    if not found then
      select name into v_item_name from items where id = v_item_id;
      raise exception 'Item "%" belum pernah ada transaksi stok masuk -- gak bisa diopname', coalesce(v_item_name, v_item_id::text);
    end if;

    v_variance := v_qty_actual - v_qty_system;

    if v_variance = 0 then
      continue;
    end if;

    v_value := abs(v_variance) * v_avg_cost;
    v_any_line := true;

    if v_variance < 0 then
      v_entry_id := create_journal_entry(
        p_opname_date, 'Selisih stok opname (kurang)', p_source_ref,
        jsonb_build_array(
          jsonb_build_object('account_id', p_shortage_expense_account_id, 'debit', v_value, 'credit', 0),
          jsonb_build_object('account_id', v_inventory_account_id, 'debit', 0, 'credit', v_value)
        )
      );
    else
      v_entry_id := create_journal_entry(
        p_opname_date, 'Selisih stok opname (lebih)', p_source_ref,
        jsonb_build_array(
          jsonb_build_object('account_id', v_inventory_account_id, 'debit', v_value, 'credit', 0),
          jsonb_build_object('account_id', p_surplus_revenue_account_id, 'debit', 0, 'credit', v_value)
        )
      );
    end if;

    insert into stock_opname_lines (stock_opname_id, item_id, qty_system, qty_actual, unit_cost, journal_entry_id)
    values (v_opname_id, v_item_id, v_qty_system, v_qty_actual, v_avg_cost, v_entry_id);

    update inventory_balances
      set qty_on_hand = v_qty_actual, updated_at = now()
      where item_id = v_item_id;
  end loop;

  if not v_any_line then
    raise exception 'Gak ada selisih ditemukan di opname ini -- semua item cocok, gak perlu dicatat';
  end if;

  return v_opname_id;
end;
$$;

-- ============================================================
-- Accounts Receivable (0005_ar_schema.sql)
-- ============================================================

create or replace function ar_credit_notes_no_over_return() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_already_returned numeric;
  v_invoice_ref text;
begin
  select amount into v_invoice_amount from ar_invoices where id = new.invoice_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from ar_credit_notes where invoice_id = new.invoice_id;

  if v_already_returned + new.amount > v_invoice_amount then
    select source_ref into v_invoice_ref from ar_invoices where id = new.invoice_id;
    raise exception 'Retur invoice % melebihi nilai invoice (invoice %, sudah diretur %, coba retur %)',
      v_invoice_ref, v_invoice_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function inventory_return_lines_guard() returns trigger as $$
declare
  v_goods_issue_id uuid;
  v_qty_issued numeric;
  v_qty_already_returned numeric;
  v_item_name text;
  v_goods_issue_ref text;
begin
  select ir.goods_issue_id into v_goods_issue_id
    from inventory_returns ir where ir.id = new.inventory_return_id;

  select gil.qty_issued into v_qty_issued
    from goods_issue_lines gil
    where gil.goods_issue_id = v_goods_issue_id and gil.item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_goods_issue_ref from goods_issues where id = v_goods_issue_id;
    raise exception 'Item "%" gak ada di Goods Issue %, gak bisa diretur', v_item_name, v_goods_issue_ref;
  end if;

  select coalesce(sum(irl.qty_returned), 0) into v_qty_already_returned
    from inventory_return_lines irl
    join inventory_returns ir2 on ir2.id = irl.inventory_return_id
    where ir2.goods_issue_id = v_goods_issue_id and irl.item_id = new.item_id;

  if v_qty_already_returned + new.qty_returned > v_qty_issued then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Retur item "%" melebihi qty terjual (terjual %, sudah diretur %, coba retur %)',
      v_item_name, v_qty_issued, v_qty_already_returned, new.qty_returned;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function warranty_replacement_lines_no_over_replace() returns trigger as $$
declare
  v_credit_note_id uuid;
  v_qty_returned numeric;
  v_qty_already_replaced numeric;
  v_item_name text;
  v_credit_note_ref text;
begin
  select wr.credit_note_id into v_credit_note_id
    from warranty_replacements wr where wr.id = new.warranty_replacement_id;

  select coalesce(sum(irl.qty_returned), 0) into v_qty_returned
    from inventory_return_lines irl
    join inventory_returns ir on ir.id = irl.inventory_return_id
    where ir.credit_note_id = v_credit_note_id and irl.item_id = new.item_id;

  if v_qty_returned = 0 then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_credit_note_ref from ar_credit_notes where id = v_credit_note_id;
    raise exception 'Item "%" gak ada di retur %, gak bisa diganti', v_item_name, v_credit_note_ref;
  end if;

  select coalesce(sum(wrl.qty_replaced), 0) into v_qty_already_replaced
    from warranty_replacement_lines wrl
    join warranty_replacements wr2 on wr2.id = wrl.warranty_replacement_id
    where wr2.credit_note_id = v_credit_note_id and wrl.item_id = new.item_id;

  if v_qty_already_replaced + new.qty_replaced > v_qty_returned then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Penggantian item "%" melebihi qty retur (diretur %, sudah diganti %, coba ganti %)',
      v_item_name, v_qty_returned, v_qty_already_replaced, new.qty_replaced;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function warranty_replacements_no_over_settle_return_credit() returns trigger as $$
declare
  v_credit_id uuid;
  v_remaining numeric;
  v_credit_note_ref text;
begin
  if new.return_credit_settled_amount = 0 then
    return new;
  end if;

  select id into v_credit_id from ar_return_credits where credit_note_id = new.credit_note_id;

  if v_credit_id is null then
    select source_ref into v_credit_note_ref from ar_credit_notes where id = new.credit_note_id;
    raise exception 'Retur % gak punya saldo kredit retur aktif — gak bisa isi return_credit_settled_amount', v_credit_note_ref;
  end if;

  select ar_return_credit_remaining(v_credit_id) into v_remaining;

  if new.return_credit_settled_amount > v_remaining then
    select acn.source_ref into v_credit_note_ref
      from ar_return_credits arc join ar_credit_notes acn on acn.id = arc.credit_note_id
      where arc.id = v_credit_id;
    raise exception 'Penyelesaian saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba selesaikan %)',
      v_credit_note_ref, v_remaining, new.return_credit_settled_amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ar_deposit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_customer_id uuid;
  v_invoice_customer_id uuid;
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_invoice_remaining numeric;
  v_deposit_ref text;
  v_invoice_ref text;
begin
  select ar_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    select source_ref into v_deposit_ref from ar_deposits where id = new.deposit_id;
    raise exception 'Penerapan deposit % melebihi sisa deposit (sisa %, coba terapkan %)',
      v_deposit_ref, v_remaining, new.amount;
  end if;

  select customer_id into v_deposit_customer_id from ar_deposits where id = new.deposit_id;
  select customer_id, journal_entry_id into v_invoice_customer_id, v_invoice_journal_entry_id
    from ar_invoices where id = new.invoice_id;

  if v_invoice_customer_id is distinct from v_deposit_customer_id then
    select source_ref into v_deposit_ref from ar_deposits where id = new.deposit_id;
    select source_ref into v_invoice_ref from ar_invoices where id = new.invoice_id;
    raise exception 'Deposit % milik customer lain — gak bisa diterapkan ke invoice %', v_deposit_ref, v_invoice_ref;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_invoice_journal_entry_id
  ) into v_invoice_cancelled;

  if v_invoice_cancelled then
    select source_ref into v_invoice_ref from ar_invoices where id = new.invoice_id;
    raise exception 'Invoice % udah dibatalkan — gak bisa diterapkan DP ke situ', v_invoice_ref;
  end if;

  select ar_invoice_remaining(new.invoice_id) into v_invoice_remaining;

  if new.amount > v_invoice_remaining then
    select source_ref into v_invoice_ref from ar_invoices where id = new.invoice_id;
    raise exception 'Penerapan deposit ke invoice % melebihi sisa piutang (sisa %, coba terapkan %)',
      v_invoice_ref, v_invoice_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ar_deposit_forfeitures_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_ref text;
begin
  select ar_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    select source_ref into v_deposit_ref from ar_deposits where id = new.deposit_id;
    raise exception 'Forfeiture deposit % melebihi sisa deposit (sisa %, coba hanguskan %)',
      v_deposit_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ar_deposit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_ref text;
begin
  select ar_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    select source_ref into v_deposit_ref from ar_deposits where id = new.deposit_id;
    raise exception 'Refund deposit % melebihi sisa deposit (sisa %, coba refund %)',
      v_deposit_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ar_bad_debt_writeoffs_no_over_writeoff() returns trigger as $$
declare
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_invoice_remaining numeric;
  v_invoice_ref text;
begin
  select journal_entry_id into v_invoice_journal_entry_id from ar_invoices where id = new.invoice_id;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_invoice_journal_entry_id
  ) into v_invoice_cancelled;

  if v_invoice_cancelled then
    select source_ref into v_invoice_ref from ar_invoices where id = new.invoice_id;
    raise exception 'Invoice % udah dibatalkan — gak bisa di-write-off', v_invoice_ref;
  end if;

  select ar_invoice_remaining(new.invoice_id) into v_invoice_remaining;

  if new.amount > v_invoice_remaining then
    select source_ref into v_invoice_ref from ar_invoices where id = new.invoice_id;
    raise exception 'Write-off invoice % melebihi sisa outstanding riil (sisa %, coba write-off %)',
      v_invoice_ref, v_invoice_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ar_return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_credit_note_ref text;
begin
  select ar_return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    select acn.source_ref into v_credit_note_ref
      from ar_return_credits arc join ar_credit_notes acn on acn.id = arc.credit_note_id
      where arc.id = new.credit_id;
    raise exception 'Refund saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba refund %)',
      v_credit_note_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function record_ar_payment(
  p_customer_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_receivable_account_id uuid,
  p_invoice_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
  v_invoice_ref text;
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining;

  if p_amount > v_remaining then
    select source_ref into v_invoice_ref from ar_invoices where id = p_invoice_id;
    raise exception 'Payment % melebihi sisa piutang invoice % (sisa %, coba bayar %) -- gak boleh overpay',
      p_source_ref, v_invoice_ref, v_remaining, p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan piutang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_payments (customer_id, invoice_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_customer_id, p_invoice_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

create or replace function cancel_ar_invoice(
  p_invoice_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_paid_count int;
  v_written_off_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
  v_invoice_ref text;
begin
  select count(*) into v_paid_count
  from ar_payments where invoice_id = p_invoice_id;

  if v_paid_count > 0 then
    select source_ref into v_invoice_ref from ar_invoices where id = p_invoice_id;
    raise exception 'Invoice % udah punya payment — gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
  end if;

  select count(*) into v_written_off_count
  from ar_bad_debt_writeoffs where invoice_id = p_invoice_id;

  if v_written_off_count > 0 then
    select source_ref into v_invoice_ref from ar_invoices where id = p_invoice_id;
    raise exception 'Invoice % udah punya % write-off piutang tak tertagih — gak bisa dibatalkan lewat jalur ini', v_invoice_ref, v_written_off_count;
  end if;

  select journal_entry_id into v_original_entry_id from ar_invoices where id = p_invoice_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select ada.journal_entry_id
    from ar_deposit_applications ada
    where ada.invoice_id = p_invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

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
  v_invoice_ref text;
  v_item_name text;
  v_goods_issue_ref text;
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
      select source_ref into v_invoice_ref from ar_invoices where id = p_invoice_id;
      raise exception 'Invoice % gak punya goods_issue — gak bisa retur stok/HPP', v_invoice_ref;
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
        select name into v_item_name from items where id = v_item_id;
        select source_ref into v_goods_issue_ref from goods_issues where id = v_goods_issue_id;
        raise exception 'Item "%" gak ada di Goods Issue %, gak bisa diretur', v_item_name, v_goods_issue_ref;
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

create or replace function create_warranty_replacement(
  p_credit_note_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb,
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
  v_credit_note_ref text;
  v_item_name text;
begin
  select source_ref into v_credit_note_ref from ar_credit_notes where id = p_credit_note_id;

  if not exists (select 1 from inventory_returns where credit_note_id = p_credit_note_id) then
    raise exception 'Retur % financial-only (gak ada retur fisik) — gak bisa bikin penukaran barang', coalesce(v_credit_note_ref, p_credit_note_id::text);
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
      select name into v_item_name from items where id = v_item_id;
      raise exception 'Item "%" gak ada di retur %, gak bisa ditukar', v_item_name, v_credit_note_ref;
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
          v_credit_note_ref, v_reversal_amount, v_return_credit_remaining;
      end if;

      if p_return_credit_liability_account_id is null then
        raise exception 'Retur % punya saldo kredit retur aktif (sisa %) — wajib isi p_return_credit_liability_account_id buat settle via barang',
          v_credit_note_ref, v_return_credit_remaining;
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
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_replacement_id;
end;
$$;

-- ============================================================
-- Accounts Payable (0006_ap_schema.sql)
-- ============================================================

create or replace function ap_credit_notes_no_over_return() returns trigger as $$
declare
  v_bill_amount numeric;
  v_already_returned numeric;
  v_bill_ref text;
begin
  select amount into v_bill_amount from ap_bills where id = new.bill_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from ap_credit_notes where bill_id = new.bill_id;

  if v_already_returned + new.amount > v_bill_amount then
    select source_ref into v_bill_ref from ap_bills where id = new.bill_id;
    raise exception 'Retur bill % melebihi nilai bill (bill %, sudah diretur %, coba retur %)',
      v_bill_ref, v_bill_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function purchase_return_lines_no_over_return() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
  v_bill_ref text;
  v_item_name text;
begin
  select bill_id into v_bill_id from ap_credit_notes where id = new.credit_note_id;
  select id into v_grn_id from goods_receipt_notes where bill_id = v_bill_id;

  if v_grn_id is null then
    select source_ref into v_bill_ref from ap_bills where id = v_bill_id;
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok per item', v_bill_ref;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_bill_ref from ap_bills where id = v_bill_id;
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

create or replace function purchase_replacement_lines_no_over_return() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
  v_bill_ref text;
  v_item_name text;
begin
  select bill_id into v_bill_id from purchase_replacements where id = new.purchase_replacement_id;
  select id into v_grn_id from goods_receipt_notes where bill_id = v_bill_id;

  if v_grn_id is null then
    select source_ref into v_bill_ref from ap_bills where id = v_bill_id;
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tukar barang per item', v_bill_ref;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_bill_ref from ap_bills where id = v_bill_id;
    raise exception 'Item "%" gak ada di goods receipt bill %, gak bisa ditukar', v_item_name, v_bill_ref;
  end if;

  select purchase_returned_qty(v_bill_id, new.item_id) into v_already;

  if v_already + new.qty_replaced > v_qty_received then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Tukar barang item "%" melebihi qty diterima (diterima %, sudah diklaim %, coba tukar %)',
      v_item_name, v_qty_received, v_already, new.qty_replaced;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function purchase_writeoff_lines_no_over_return() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
  v_bill_ref text;
  v_item_name text;
begin
  select bill_id into v_bill_id from purchase_writeoffs where id = new.purchase_writeoff_id;
  select id into v_grn_id from goods_receipt_notes where bill_id = v_bill_id;

  if v_grn_id is null then
    select source_ref into v_bill_ref from ap_bills where id = v_bill_id;
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tulis-jadi-beban per item', v_bill_ref;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_bill_ref from ap_bills where id = v_bill_id;
    raise exception 'Item "%" gak ada di goods receipt bill %, gak bisa ditulis-jadi-beban', v_item_name, v_bill_ref;
  end if;

  select purchase_returned_qty(v_bill_id, new.item_id) into v_already;

  if v_already + new.qty_written_off > v_qty_received then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Write-off item "%" melebihi qty diterima (diterima %, sudah diklaim %, coba write-off %)',
      v_item_name, v_qty_received, v_already, new.qty_written_off;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ap_deposit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_supplier_id uuid;
  v_bill_supplier_id uuid;
  v_bill_journal_entry_id uuid;
  v_bill_cancelled boolean;
  v_bill_remaining numeric;
  v_deposit_ref text;
  v_bill_ref text;
begin
  select ap_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    select source_ref into v_deposit_ref from ap_deposits where id = new.deposit_id;
    raise exception 'Penerapan deposit % melebihi sisa deposit (sisa %, coba terapkan %)',
      v_deposit_ref, v_remaining, new.amount;
  end if;

  select supplier_id into v_deposit_supplier_id from ap_deposits where id = new.deposit_id;
  select supplier_id, journal_entry_id into v_bill_supplier_id, v_bill_journal_entry_id
    from ap_bills where id = new.bill_id;

  if v_bill_supplier_id is distinct from v_deposit_supplier_id then
    select source_ref into v_deposit_ref from ap_deposits where id = new.deposit_id;
    select source_ref into v_bill_ref from ap_bills where id = new.bill_id;
    raise exception 'Deposit % milik supplier lain -- gak bisa diterapkan ke bill %', v_deposit_ref, v_bill_ref;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_bill_journal_entry_id
  ) into v_bill_cancelled;

  if v_bill_cancelled then
    select source_ref into v_bill_ref from ap_bills where id = new.bill_id;
    raise exception 'Bill % udah dibatalkan -- gak bisa diterapkan DP ke situ', v_bill_ref;
  end if;

  select ap_bill_remaining(new.bill_id) into v_bill_remaining;

  if new.amount > v_bill_remaining then
    select source_ref into v_bill_ref from ap_bills where id = new.bill_id;
    raise exception 'Penerapan deposit ke bill % melebihi sisa utang (sisa %, coba terapkan %)',
      v_bill_ref, v_bill_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ap_deposit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_ref text;
begin
  select ap_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    select source_ref into v_deposit_ref from ap_deposits where id = new.deposit_id;
    raise exception 'Refund deposit % melebihi sisa deposit (sisa %, coba refund %)',
      v_deposit_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ap_deposit_forfeitures_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_ref text;
begin
  select ap_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    select source_ref into v_deposit_ref from ap_deposits where id = new.deposit_id;
    raise exception 'Forfeiture deposit % melebihi sisa deposit (sisa %, coba hanguskan %)',
      v_deposit_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ap_return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_credit_note_ref text;
begin
  select ap_return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    select acn.source_ref into v_credit_note_ref
      from ap_return_credits arc join ap_credit_notes acn on acn.id = arc.credit_note_id
      where arc.id = new.credit_id;
    raise exception 'Refund saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba refund %)',
      v_credit_note_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function record_ap_payment(
  p_supplier_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_payable_account_id uuid,
  p_cash_account_id uuid,
  p_bill_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
  v_bill_ref text;
begin
  select ap_bill_remaining(p_bill_id) into v_remaining;

  if p_amount > v_remaining then
    select source_ref into v_bill_ref from ap_bills where id = p_bill_id;
    raise exception 'Payment % melebihi sisa utang bill % (sisa %, coba bayar %) -- gak boleh overpay',
      p_source_ref, v_bill_ref, v_remaining, p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan utang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_payments (supplier_id, bill_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_supplier_id, p_bill_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

create or replace function cancel_ap_bill(
  p_bill_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_allocated_count int;
  v_credit_note_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
  v_bill_ref text;
begin
  select count(*) into v_allocated_count
  from ap_payments where bill_id = p_bill_id;

  if v_allocated_count > 0 then
    select source_ref into v_bill_ref from ap_bills where id = p_bill_id;
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from ap_credit_notes where bill_id = p_bill_id;

  if v_credit_note_count > 0 then
    select source_ref into v_bill_ref from ap_bills where id = p_bill_id;
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from ap_bills where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select ada.journal_entry_id
    from ap_deposit_applications ada
    where ada.bill_id = p_bill_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
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
  v_bill_ref text;
begin
  select ap_bill_remaining(p_bill_id) into v_remaining_before;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

    if v_grn_id is null then
      select source_ref into v_bill_ref from ap_bills where id = p_bill_id;
      raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok', coalesce(v_bill_ref, p_bill_id::text);
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

  insert into ap_credit_notes (bill_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values (p_bill_id, p_credit_note_date, p_source_ref, v_effective_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  if array_length(v_line_items, 1) is not null then
    for i in 1..array_length(v_line_items, 1) loop
      insert into purchase_return_lines (credit_note_id, item_id, qty_returned, total_cost)
      values (v_credit_note_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
    end loop;
  end if;

  v_excess := greatest(0, v_effective_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_asset_account_id is null then
      raise exception 'Retur % bikin Utang Usaha jadi minus (excess %) -- wajib isi p_return_credit_asset_account_id',
        p_source_ref, v_excess;
    end if;

    select supplier_id into v_supplier_id from ap_bills where id = p_bill_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Piutang retur dari supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_return_credit_asset_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into ap_return_credits (supplier_id, credit_note_id, amount, journal_entry_id, created_by)
    values (v_supplier_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  return v_credit_note_id;
end;
$$;

create or replace function create_purchase_replacement(
  p_bill_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb,
  p_inventory_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_grn_id uuid;
  v_replacement_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_line_cost numeric;
  v_unit_cost numeric;
  v_total_cost numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_bill_ref text;
begin
  select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

  if v_grn_id is null then
    select source_ref into v_bill_ref from ap_bills where id = p_bill_id;
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tukar barang per item', coalesce(v_bill_ref, p_bill_id::text);
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Tukar barang butuh minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);
    v_unit_cost := v_line_cost / v_qty;

    select qty_on_hand, avg_cost into v_qty_before, v_avg_before
      from inventory_balances where item_id = v_item_id;

    update inventory_balances
      set qty_on_hand = v_qty_before + v_qty,
          avg_cost = (v_qty_before * v_avg_before + v_qty * v_unit_cost) / (v_qty_before + v_qty),
          updated_at = now()
      where item_id = v_item_id;

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Tukar barang rusak dengan barang baik dari supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into purchase_replacements (bill_id, replacement_date, source_ref, journal_entry_id, created_by)
  values (p_bill_id, p_replacement_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_replacement_id;

  for i in 1..array_length(v_line_items, 1) loop
    insert into purchase_replacement_lines (purchase_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_replacement_id;
end;
$$;

create or replace function create_purchase_writeoff(
  p_bill_id uuid,
  p_writeoff_date date,
  p_source_ref text,
  p_lines jsonb,
  p_loss_expense_account_id uuid,
  p_inventory_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_grn_id uuid;
  v_writeoff_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_bill_ref text;
begin
  select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

  if v_grn_id is null then
    select source_ref into v_bill_ref from ap_bills where id = p_bill_id;
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tulis-jadi-beban per item', coalesce(v_bill_ref, p_bill_id::text);
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Tulis-jadi-beban butuh minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_writeoff_date, 'Barang rusak ditulis-jadi-beban -- supplier tolak kompensasi', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_loss_expense_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into purchase_writeoffs (bill_id, writeoff_date, source_ref, journal_entry_id, created_by)
  values (p_bill_id, p_writeoff_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_writeoff_id;

  for i in 1..array_length(v_line_items, 1) loop
    insert into purchase_writeoff_lines (purchase_writeoff_id, item_id, qty_written_off, total_cost)
    values (v_writeoff_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_writeoff_id;
end;
$$;

-- ============================================================
-- Fixed Assets (0007_fixed_assets_schema.sql)
-- ============================================================

create or replace function depreciation_entries_cap_check() returns trigger as $$
declare
  v_cost numeric;
  v_salvage numeric;
  v_accumulated numeric;
  v_asset_name text;
begin
  select acquisition_cost, salvage_value, name into v_cost, v_salvage, v_asset_name
    from fixed_assets where id = new.fixed_asset_id;

  select coalesce(sum(amount), 0) into v_accumulated
    from depreciation_entries where fixed_asset_id = new.fixed_asset_id;

  if v_accumulated + new.amount > v_cost - v_salvage then
    raise exception 'Penyusutan aset "%" melebihi batas (sisa %, coba %)',
      v_asset_name, (v_cost - v_salvage) - v_accumulated, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function fixed_assets_published_lock() returns trigger as $$
begin
  if (old.asset_account_id, old.accumulated_depreciation_account_id, old.depreciation_expense_account_id,
      old.acquisition_cost, old.salvage_value, old.useful_life_months, old.acquisition_date,
      old.depreciation_method, old.depreciation_rate)
     is distinct from
     (new.asset_account_id, new.accumulated_depreciation_account_id, new.depreciation_expense_account_id,
      new.acquisition_cost, new.salvage_value, new.useful_life_months, new.acquisition_date,
      new.depreciation_method, new.depreciation_rate) then
    if exists (select 1 from depreciation_entries where fixed_asset_id = old.id) then
      raise exception 'Aset "%" sudah punya penyusutan — field nilai/akun/metode terkunci', old.name;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

-- ============================================================
-- POS (0009_pos_schema.sql)
-- ============================================================

create or replace function void_pos_sale(
  p_sale_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_sale record;
  v_already_voided boolean;
  v_new_revenue_entry_id uuid;
begin
  select * into v_sale from pos_sales where id = p_sale_id;

  if not found then
    raise exception 'POS sale % gak ditemukan', p_sale_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_sale.revenue_journal_entry_id
  ) into v_already_voided;

  if v_already_voided then
    raise exception 'POS sale % udah pernah dibatalkan', v_sale.source_ref;
  end if;

  v_new_revenue_entry_id := reverse_journal_entry(v_sale.revenue_journal_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_sale.cogs_journal_entry_id, p_entry_date, p_source_ref);

  update inventory_balances ib
    set qty_on_hand = ib.qty_on_hand + agg.qty_sold,
        updated_at = now()
    from (
      select item_id, sum(qty_sold) as qty_sold
      from pos_sale_lines
      where pos_sale_id = p_sale_id
      group by item_id
    ) agg
    where ib.item_id = agg.item_id;

  return v_new_revenue_entry_id;
end;
$$;
