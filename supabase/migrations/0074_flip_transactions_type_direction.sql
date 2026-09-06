-- Balik makna type ('INBOUND'/'OUTBOUND') KHUSUS di transactions/payments/deposits, dari
-- basis piutang/utang (INBOUND=AR/piutang, OUTBOUND=AP/utang) jadi basis arah fisik barang
-- keluarga transaksi (INBOUND=barang masuk=pembelian/AP, OUTBOUND=barang keluar=penjualan/AR).
-- Keputusan owner 2026-09-06, didiskusikan lengkap dengan bukti kenapa payments/deposits/
-- financial-only transactions gak punya "arah barang" sendiri (murni event uang) sehingga
-- ikut label KELUARGA, bukan label per-baris.
--
-- credit_notes/return_credits (retur) SENGAJA TIDAK IKUT DIBALIK -- nilai type di situ udah
-- benar dari awal (retur customer = barang masuk = INBOUND, retur ke supplier = barang keluar
-- = OUTBOUND) justru karena retur adalah PEMBALIKAN dari arah induknya. Konsekuensinya cuma 1
-- trigger yang logic-nya berubah: credit_notes_type_matches_transaction, dari cek SAMA jadi cek
-- KEBALIKAN terhadap transactions.type (lihat migration 0075 buat perubahan itu + rename
-- credit_notes -> returns, dependent ke migration ini).
--
-- KRUSIAL: create_transaction/record_payment/create_deposit/apply_deposit/refund_deposit/
-- forfeit_deposit semua menentukan arah debit/kredit jurnal lewat `if p_type/v_type='INBOUND'`.
-- Body-body ini WAJIB ikut diubah (bukan cuma data + caller) -- kalau cuma data/caller yang
-- dibalik tanpa body ikut dibalik, jurnal AR/AP bakal tetap balance (debit=kredit) tapi ke akun
-- yang SALAH ARAH (invoice jual kecatat pakai logic akun utang). Isi tiap branch (jurnal,
-- deskripsi) TIDAK berubah -- cuma literal yang dibandingkan di kondisi if/case yang ditukar.

-- ============================================================
-- 1. Lepas trigger immutability sementara (WAJIB, existing trigger nolak keras perubahan
--    kolom `type` -- transactions_block_edit_delete_or_sync/payments block_edit_delete/
--    deposits_block_edit_delete_or_sync semua nganggep type kolom bisnis yang gak boleh diubah).
-- ============================================================
drop trigger transactions_block_edit_delete on transactions;
drop trigger payments_block_edit_delete on payments;
drop trigger deposits_block_edit_delete on deposits;

-- ============================================================
-- 2. Balik isi kolom type di 3 tabel -- credit_notes/return_credits TIDAK disentuh.
-- ============================================================
update transactions set type = case when type = 'INBOUND' then 'OUTBOUND' else 'INBOUND' end;
update payments set type = case when type = 'INBOUND' then 'OUTBOUND' else 'INBOUND' end;
update deposits set type = case when type = 'INBOUND' then 'OUTBOUND' else 'INBOUND' end;

-- ============================================================
-- 3. Pasang balik trigger immutability -- fungsi & bodynya TIDAK berubah (gak nyebut literal
--    INBOUND/OUTBOUND sama sekali, cuma ngecek "kolom bisnis berubah atau enggak").
-- ============================================================
create trigger transactions_block_edit_delete
  before update or delete on transactions
  for each row execute function transactions_block_edit_delete_or_sync();

create trigger payments_block_edit_delete
  before update or delete on payments
  for each row execute function block_edit_delete();

create trigger deposits_block_edit_delete
  before update or delete on deposits
  for each row execute function deposits_block_edit_delete_or_sync();

-- ============================================================
-- 4. Trigger role-guard -- tukar arah role per type (INBOUND dulu wajib customer, sekarang
--    wajib supplier; OUTBOUND sebaliknya). Pola sama di transactions/payments/deposits.
-- ============================================================
drop trigger transactions_counterparty_role_guard_inbound on transactions;
drop trigger transactions_counterparty_role_guard_outbound on transactions;

create trigger transactions_counterparty_role_guard_inbound
  before insert on transactions
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

create trigger transactions_counterparty_role_guard_outbound
  before insert on transactions
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

drop trigger payments_counterparty_role_guard_inbound on payments;
drop trigger payments_counterparty_role_guard_outbound on payments;

create trigger payments_counterparty_role_guard_inbound
  before insert on payments
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

create trigger payments_counterparty_role_guard_outbound
  before insert on payments
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

drop trigger deposits_counterparty_role_guard_inbound on deposits;
drop trigger deposits_counterparty_role_guard_outbound on deposits;

create trigger deposits_counterparty_role_guard_inbound
  before insert on deposits
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

create trigger deposits_counterparty_role_guard_outbound
  before insert on deposits
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

-- ============================================================
-- 5. create_transaction -- tukar literal di TIAP kondisi yang milih branch AR vs AP (isi
--    branch TIDAK berubah). AR (Piutang/Pendapatan/ppn keluaran) sekarang masuk lewat
--    p_type='OUTBOUND', AP (Utang/Beban/ppn masukan) lewat p_type='INBOUND'.
-- ============================================================
create or replace function create_transaction(
  p_type text,
  p_counterparty_id uuid,
  p_date date,
  p_description text,
  p_source_ref text,
  p_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- kategori, BUKAN termasuk PPN
  p_control_account_id uuid, -- OUTBOUND: Piutang Usaha, INBOUND: Utang Usaha
  p_apply_tax boolean default false,
  p_supplier_document_ref text default null -- cuma dipakai type='INBOUND'
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_transaction_id uuid;
  v_line jsonb;
  v_line_amount numeric;
  v_subtotal numeric := 0;
  v_tax_amount numeric := 0;
  v_total_amount numeric;
  v_tax_active boolean;
  v_tax_rate numeric;
  v_tax_account_id uuid;
  v_journal_lines jsonb;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'p_lines wajib punya minimal 1 baris';
  end if;

  select payment_term_days into v_term_days from counterparties where id = p_counterparty_id;
  v_due_date := p_date + v_term_days;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_amount := (v_line->>'amount')::numeric;
    if v_line_amount <= 0 then
      raise exception 'Setiap baris p_lines harus amount > 0, dapat %', v_line_amount;
    end if;
    v_subtotal := v_subtotal + v_line_amount;
  end loop;

  if p_apply_tax then
    select is_active, ppn_rate,
           case when p_type = 'OUTBOUND' then ppn_keluaran_account_id else ppn_masukan_account_id end
      into v_tax_active, v_tax_rate, v_tax_account_id
      from tax_settings;

    if not v_tax_active or v_tax_account_id is null then
      raise exception 'PPN belum aktif atau akun PPN belum diset';
    end if;

    v_tax_amount := round(v_subtotal * v_tax_rate / 100, 2);
  end if;

  v_total_amount := v_subtotal + v_tax_amount;

  -- baris FIXED: control account (Piutang debit / Utang kredit)
  if p_type = 'OUTBOUND' then
    v_journal_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_control_account_id, 'debit', v_total_amount, 'credit', 0)
    );
  else
    v_journal_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_control_account_id, 'debit', 0, 'credit', v_total_amount)
    );
  end if;

  -- baris VARIABEL: kategori dari p_lines, arah kebalik dari baris FIXED
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_amount := (v_line->>'amount')::numeric;
    if p_type = 'OUTBOUND' then
      v_journal_lines := v_journal_lines || jsonb_build_array(
        jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', 0, 'credit', v_line_amount)
      );
    else
      v_journal_lines := v_journal_lines || jsonb_build_array(
        jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', v_line_amount, 'credit', 0)
      );
    end if;
  end loop;

  if p_apply_tax then
    if p_type = 'OUTBOUND' then
      v_journal_lines := v_journal_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_tax_account_id, 'debit', 0, 'credit', v_tax_amount)
      );
    else
      v_journal_lines := v_journal_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_tax_account_id, 'debit', v_tax_amount, 'credit', 0)
      );
    end if;
  end if;

  v_entry_id := create_journal_entry(p_date, p_description, p_source_ref, v_journal_lines);

  insert into transactions (
    type, counterparty_id, date, due_date, description, source_ref, amount,
    outstanding, status, supplier_document_ref, journal_entry_id, created_by
  )
  values (
    p_type, p_counterparty_id, p_date, v_due_date, p_description, p_source_ref, v_total_amount,
    v_total_amount, 'belum',
    case when p_type = 'INBOUND' then p_supplier_document_ref else null end,
    v_entry_id, auth.uid()
  )
  returning id into v_transaction_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
  end loop;

  if p_apply_tax then
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, v_tax_account_id, v_tax_amount, true);
  end if;

  return v_transaction_id;
end;
$$;

-- ============================================================
-- 6. record_payment -- sama pola, AR sekarang p_type='OUTBOUND'.
-- ============================================================
create or replace function record_payment(
  p_type text,
  p_counterparty_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_control_account_id uuid, -- OUTBOUND: Piutang Usaha, INBOUND: Utang Usaha
  p_transaction_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
  v_ref text;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_type = 'OUTBOUND' then
    select ar_invoice_remaining(p_transaction_id) into v_remaining;
  else
    select ap_bill_remaining(p_transaction_id) into v_remaining;
  end if;

  if p_amount > v_remaining then
    select source_ref into v_ref from transactions where id = p_transaction_id;
    raise exception 'Payment % melebihi sisa % % (sisa %, coba bayar %) -- gak boleh overpay',
      p_source_ref,
      case when p_type = 'OUTBOUND' then 'piutang invoice' else 'utang bill' end,
      v_ref, v_remaining, p_amount;
  end if;

  if p_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_payment_date, 'Pelunasan piutang', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_control_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_payment_date, 'Pelunasan utang', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_control_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into payments (type, counterparty_id, transaction_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_type, p_counterparty_id, p_transaction_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

-- ============================================================
-- 7. create_deposit/apply_deposit/refund_deposit/forfeit_deposit -- sama pola.
-- ============================================================
create or replace function create_deposit(
  p_type text,
  p_counterparty_id uuid,
  p_deposit_date date,
  p_source_ref text,
  p_amount numeric,
  p_cash_account_id uuid,
  p_deposit_account_id uuid -- OUTBOUND: Uang Muka Penjualan (liability), INBOUND: Uang Muka Pembelian (asset)
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_deposit_id uuid;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_deposit_date, 'Uang muka diterima', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_deposit_date, 'Uang muka dibayar ke supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into deposits (type, counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_by)
  values (p_type, p_counterparty_id, p_deposit_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_deposit_id;

  return v_deposit_id;
end;
$$;

create or replace function apply_deposit(
  p_deposit_id uuid,
  p_transaction_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_deposit_account_id uuid,
  p_control_account_id uuid -- OUTBOUND: Piutang Usaha, INBOUND: Utang Usaha
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_entry_id uuid;
  v_application_id uuid;
begin
  select type into v_type from deposits where id = p_deposit_id;

  if v_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_entry_date, 'Penerapan uang muka ke invoice', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_control_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_entry_date, 'Penerapan uang muka ke bill', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_control_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into deposit_applications (deposit_id, transaction_id, amount, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_transaction_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_application_id;

  return v_application_id;
end;
$$;

create or replace function refund_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_refund_date date,
  p_source_ref text,
  p_deposit_account_id uuid,
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
  select type into v_type from deposits where id = p_deposit_id;

  if v_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_refund_date, 'Refund uang muka', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_refund_date, 'Refund uang muka dari supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into deposit_refunds (deposit_id, amount, refund_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_refund_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

create or replace function forfeit_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_forfeiture_date date,
  p_source_ref text,
  p_deposit_account_id uuid,
  p_offset_account_id uuid -- OUTBOUND: Pendapatan Lain-lain (kredit), INBOUND: Beban Kerugian Uang Muka (debit)
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_entry_id uuid;
  v_forfeiture_id uuid;
begin
  select type into v_type from deposits where id = p_deposit_id;

  if v_type = 'OUTBOUND' then
    v_entry_id := create_journal_entry(
      p_forfeiture_date, 'Uang muka hangus', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_offset_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_forfeiture_date, 'Uang muka hangus', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_offset_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_deposit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into deposit_forfeitures (deposit_id, amount, forfeiture_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_forfeiture_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_forfeiture_id;

  return v_forfeiture_id;
end;
$$;

-- ============================================================
-- 8. create_goods_issue/create_goods_receipt -- pemanggil create_transaction, tukar 1 literal
--    argumen masing-masing. Body lain gak berubah sama sekali.
-- ============================================================
create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb,
  p_receivable_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"order_line_id":uuid|null}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_issue_id uuid := gen_random_uuid();
  v_invoice_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_order_line_id uuid;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_order_lines uuid[] := '{}';
  i int;
begin
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as l
    join order_lines ol on ol.id = nullif(l->>'order_line_id', '')::uuid
    join orders o on o.id = ol.order_id
    where o.cancelled_at is not null
  ) then
    raise exception 'Salah satu baris menunjuk sales order yang udah dibatalkan';
  end if;

  v_invoice_id := create_transaction(
    'OUTBOUND', p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_credit_lines, p_receivable_account_id, p_apply_tax
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;
    v_order_line_id := nullif(v_line->>'order_line_id', '')::uuid;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_line_order_lines := array_append(v_line_order_lines, v_order_line_id);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_invoice_date, 'HPP ' || p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into goods_issues (id, invoice_id, journal_entry_id, issue_date, source_ref, created_by)
  values (v_issue_id, v_invoice_id, v_entry_id, p_invoice_date, p_source_ref, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into goods_issue_lines (goods_issue_id, item_id, qty_issued, total_cost, order_line_id)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_order_lines[i]);
  end loop;

  return v_issue_id;
end;
$$;

create or replace function create_goods_receipt(
  p_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- array of {"order_line_id":uuid|null,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric}
  p_bill_description text,
  p_bill_source_ref text,
  p_debit_account_id uuid,
  p_payable_account_id uuid,
  p_extra_debit_lines jsonb default null,
  p_apply_tax boolean default false,
  p_supplier_id uuid default null -- wajib diisi kalau p_order_id NULL (terima barang langsung)
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_supplier_id uuid;
  v_line jsonb;
  v_total_amount numeric := 0;
  v_bill_id uuid;
  v_grn_id uuid;
  v_item_id uuid;
  v_qty_received numeric;
  v_unit_cost numeric;
  v_qty_before numeric;
  v_avg_before numeric;
  v_debit_lines jsonb;
  v_line_id uuid;
begin
  if p_order_id is not null then
    select counterparty_id into v_supplier_id from orders where id = p_order_id and direction = 'PURCHASE';

    if v_supplier_id is null then
      raise exception 'Order % gak ditemukan atau bukan Purchase Order', p_order_id;
    end if;

    if exists (select 1 from orders where id = p_order_id and cancelled_at is not null) then
      raise exception 'Order % udah dibatalkan — gak bisa dibuat penerimaan barang', p_order_id;
    end if;
  else
    if p_supplier_id is null then
      raise exception 'Wajib pilih supplier kalau terima barang langsung tanpa Purchase Order';
    end if;

    if not exists (
      select 1 from counterparty_type_mapping
      where counterparty_id = p_supplier_id and role = 'supplier'
    ) then
      raise exception 'Supplier % gak ditemukan', p_supplier_id;
    end if;

    v_supplier_id := p_supplier_id;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_total_amount := v_total_amount + (v_line->>'qty_received')::numeric * (v_line->>'unit_cost')::numeric;
  end loop;

  v_debit_lines := jsonb_build_array(jsonb_build_object('account_id', p_debit_account_id, 'amount', v_total_amount));
  if p_extra_debit_lines is not null then
    for v_line in select * from jsonb_array_elements(p_extra_debit_lines)
    loop
      v_debit_lines := v_debit_lines || jsonb_build_array(v_line);
    end loop;
  end if;

  v_bill_id := create_transaction(
    'INBOUND', v_supplier_id, p_receipt_date, p_bill_description, p_bill_source_ref,
    v_debit_lines,
    p_payable_account_id,
    p_apply_tax
  );

  insert into goods_receipt_notes (order_id, bill_id, delivery_note_ref, receipt_date, created_by)
  values (p_order_id, v_bill_id, p_delivery_note_ref, p_receipt_date, auth.uid())
  returning id into v_grn_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty_received := (v_line->>'qty_received')::numeric;
    v_unit_cost := (v_line->>'unit_cost')::numeric;

    insert into goods_receipt_lines (grn_id, order_line_id, item_id, qty_received, unit_cost)
    values (v_grn_id, nullif(v_line->>'order_line_id', '')::uuid, v_item_id, v_qty_received, v_unit_cost)
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_receipt_line_id)
    values (v_item_id, p_receipt_date, v_qty_received, v_line_id);

    select qty_on_hand, avg_cost into v_qty_before, v_avg_before
      from inventory_balances where item_id = v_item_id;

    if not found then
      insert into inventory_balances (item_id, qty_on_hand, avg_cost)
      values (v_item_id, v_qty_received, v_unit_cost);
    else
      update inventory_balances
        set qty_on_hand = v_qty_before + v_qty_received,
            avg_cost = (v_qty_before * v_avg_before + v_qty_received * v_unit_cost) / (v_qty_before + v_qty_received),
            updated_at = now()
        where item_id = v_item_id;
    end if;
  end loop;

  return v_grn_id;
end;
$$;

-- ============================================================
-- 9. View ar_invoices_with_status/ap_bills_with_status/ar_deposits_with_status/
--    ap_deposits_with_status -- tukar filter where type=. Kolom publik TIDAK berubah nama.
-- ============================================================
create or replace view ar_invoices_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as customer_id, date as invoice_date, due_date, description, source_ref, amount,
  journal_entry_id, created_at, outstanding::numeric as outstanding, returned::numeric as returned,
  status, origin
from transactions
where type = 'OUTBOUND';

create or replace view ap_bills_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as supplier_id, date as bill_date, due_date, description, source_ref, supplier_document_ref,
  amount, journal_entry_id, created_at, outstanding::numeric as outstanding, status, origin
from transactions
where type = 'INBOUND';

create or replace view ar_deposits_with_status
  with (security_invoker = true) as
select id, counterparty_id as customer_id, deposit_date, source_ref, amount, journal_entry_id, created_at, remaining::numeric as remaining, status
from deposits
where type = 'OUTBOUND';

create or replace view ap_deposits_with_status
  with (security_invoker = true) as
select id, counterparty_id as supplier_id, deposit_date, source_ref, amount, journal_entry_id, created_at, remaining::numeric as remaining, status
from deposits
where type = 'INBOUND';

-- ============================================================
-- 10. Reducer -- tukar literal filter payments/deposit_applications, credit_notes TIDAK
--     disentuh (return-side, gak berubah).
-- ============================================================
create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from payments where transaction_id = p_invoice_id and type = 'OUTBOUND'
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
    - coalesce((select sum(amount) from payments where transaction_id = p_bill_id and type = 'INBOUND'), 0)
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
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
  v_invoice_ref text;
begin
  select count(*) into v_paid_count
  from payments where transaction_id = p_invoice_id and type = 'OUTBOUND';

  if v_paid_count > 0 then
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
    raise exception 'Invoice % udah punya payment — gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_invoice_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select da.journal_entry_id
    from deposit_applications da
    where da.transaction_id = p_invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
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
  from payments where transaction_id = p_bill_id and type = 'INBOUND';

  if v_allocated_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from credit_notes where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_credit_note_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select da.journal_entry_id
    from deposit_applications da
    where da.transaction_id = p_bill_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

create or replace function recompute_transaction_status(p_transaction_id uuid) returns void as $$
declare
  v_type text;
  v_journal_entry_id uuid;
  v_outstanding numeric;
  v_returned numeric;
  v_is_cancelled boolean;
  v_allocated numeric;
  v_deposit_applied numeric;
  v_status text;
  v_origin text;
begin
  select type, journal_entry_id into v_type, v_journal_entry_id from transactions where id = p_transaction_id;
  if not found then
    return;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_journal_entry_id
  ) into v_is_cancelled;

  if v_type = 'OUTBOUND' then
    v_outstanding := ar_invoice_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_returned
      from credit_notes where transaction_id = p_transaction_id and type = 'INBOUND';

    select coalesce(sum(amount), 0) into v_allocated
      from payments where transaction_id = p_transaction_id and type = 'OUTBOUND';

    select coalesce(sum(amount), 0) into v_deposit_applied
      from deposit_applications where transaction_id = p_transaction_id;

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when not exists (select 1 from goods_issues gi where gi.invoice_id = p_transaction_id) then 'financial_only'
      when exists (
        select 1 from goods_issues gi
        join goods_issue_lines gil on gil.goods_issue_id = gi.id
        where gi.invoice_id = p_transaction_id and gil.order_line_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, returned = v_returned, status = v_status, origin = v_origin
      where id = p_transaction_id;
  else
    v_outstanding := ap_bill_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_allocated
      from payments where transaction_id = p_transaction_id and type = 'INBOUND';

    -- Beda dari AR: deposit_applied di sini SENGAJA exclude yang reversed (asimetri lama,
    -- disalin apa adanya, TIDAK diubah/dihomogenkan migrasi ini).
    select coalesce(sum(da.amount), 0) into v_deposit_applied
      from deposit_applications da
      where da.transaction_id = p_transaction_id
        and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id);

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when not exists (select 1 from goods_receipt_notes grn where grn.bill_id = p_transaction_id) then 'financial_only'
      when exists (
        select 1 from goods_receipt_notes grn
        where grn.bill_id = p_transaction_id and grn.order_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, status = v_status, origin = v_origin
      where id = p_transaction_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;
