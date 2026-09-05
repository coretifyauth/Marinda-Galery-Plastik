-- Fase 3 (memory/scope-debt/ar-ap-unify-transactions.md) -- migrasi struktural:
-- backfill transactions/transaction_lines dari ar_invoices+ap_bills PAKAI ID ASLI,
-- repoint FK 11 tabel turunan, unify trigger recompute, alihkan create_goods_issue/
-- create_goods_receipt ke create_transaction (0063), cabut RPC aktif Piutang Tak
-- Tertagih (keputusan owner 2026-09-05, bareng Credit Hold).
--
-- SENGAJA belum drop ar_invoices/ap_bills/ar_invoice_credit_lines/ap_bill_debit_lines/
-- ar_bad_debt_writeoffs (tabel) di sini -- pola "jeda observasi" yang sama kayak 0062
-- (drop customers/suppliers legacy): dibekukan dulu (gak ada lagi jalur tulis/baca
-- yang nyentuh, semua RPC/view yang masih hidup dialihkan ke transactions), baru
-- didrop beneran di migration TERPISAH setelah diverifikasi aman. create_ar_invoice/
-- create_ap_bill (RPC lama) ikut dibekukan apa adanya -- gak ada pemanggil lagi
-- setelah migration ini, tapi bodinya tetap valid selama tabel sumbernya belum didrop.

-- ============================================================
-- 1. Backfill transactions/transaction_lines dari ar_invoices+ap_bills, ID ASLI
--    dipertahankan -- ini yang bikin langkah 3 (repoint FK) di bawah gak perlu
--    backfill data per-baris di 11 tabel turunan, cukup pindah target constraint.
-- ============================================================

insert into transactions (
  id, type, counterparty_id, date, due_date, description, source_ref, amount,
  outstanding, returned, status, origin, supplier_document_ref, journal_entry_id,
  created_by, created_at
)
select
  id, 'INBOUND', customer_id, invoice_date, due_date, description, source_ref, amount,
  outstanding, returned, status, origin, null, journal_entry_id, created_by, created_at
from ar_invoices;

insert into transactions (
  id, type, counterparty_id, date, due_date, description, source_ref, amount,
  outstanding, returned, status, origin, supplier_document_ref, journal_entry_id,
  created_by, created_at
)
select
  id, 'OUTBOUND', supplier_id, bill_date, due_date, description, source_ref, amount,
  outstanding, 0, status, origin, supplier_document_ref, journal_entry_id, created_by, created_at
from ap_bills;

insert into transaction_lines (transaction_id, account_id, amount, is_tax)
select ar_invoice_id, account_id, amount, is_tax from ar_invoice_credit_lines;

insert into transaction_lines (transaction_id, account_id, amount, is_tax)
select ap_bill_id, account_id, amount, is_tax from ap_bill_debit_lines;

-- ============================================================
-- 2. Cabut RPC/trigger AKTIF Piutang Tak Tertagih (keputusan owner: disingkirkan
--    bareng Credit Hold, 2026-09-05). Tabel ar_bad_debt_writeoffs SENGAJA gak didrop
--    di sini (dibekukan, 2 baris histori demo, ikut didrop bareng ar_invoices dkk di
--    migration cleanup terpisah) -- yang dicabut cuma jalur yang bisa nulis/baca baru
--    ke situ, biar gak ada write baru yang diam-diam gak sinkron sama
--    recompute_transaction_status (yang gak lagi punya reducer write-off sama sekali).
-- ============================================================

drop trigger ar_bad_debt_writeoffs_no_over_writeoff_trigger on ar_bad_debt_writeoffs;
drop function ar_bad_debt_writeoffs_no_over_writeoff();

drop trigger ar_bad_debt_writeoffs_sync_invoice_status_trigger on ar_bad_debt_writeoffs;
drop function ar_bad_debt_writeoffs_sync_invoice_status();

drop function write_off_ar_invoice(uuid, date, numeric, text, uuid, uuid);

-- ============================================================
-- 3. Repoint FK 11 tabel turunan (5 AR + 6 AP) dari ar_invoices/ap_bills ke
--    transactions -- _repoint_fk generalisasi dari 0060 (orders), didefinisikan
--    ulang sementara di sini (0060 sendiri udah drop fungsinya di akhir migration
--    itu, gak persist di schema), didrop lagi di akhir bagian ini.
-- ============================================================

create function _repoint_fk(p_table regclass, p_column name, p_new_target regclass,
                             p_new_target_column name default 'id')
returns void
language plpgsql
security invoker
as $$
declare
  v_old_conname text;
  v_new_conname text;
begin
  select conname into v_old_conname
    from pg_constraint
    where conrelid = p_table and contype = 'f'
      and conkey = (
        select array_agg(attnum) from pg_attribute
        where attrelid = p_table and attname = p_column
      );

  if v_old_conname is not null then
    execute format('alter table %s drop constraint %I', p_table, v_old_conname);
  end if;

  v_new_conname := p_table::text || '_' || p_column || '_fkey';
  execute format('alter table %s add constraint %I foreign key (%I) references %s (%I)',
    p_table, v_new_conname, p_column, p_new_target, p_new_target_column);
end;
$$;

select _repoint_fk('ar_payments', 'invoice_id', 'transactions');
select _repoint_fk('ar_credit_notes', 'invoice_id', 'transactions');
select _repoint_fk('ar_deposit_applications', 'invoice_id', 'transactions');
select _repoint_fk('warranty_replacements', 'invoice_id', 'transactions');
select _repoint_fk('goods_issues', 'invoice_id', 'transactions');

select _repoint_fk('ap_payments', 'bill_id', 'transactions');
select _repoint_fk('ap_credit_notes', 'bill_id', 'transactions');
select _repoint_fk('ap_deposit_applications', 'bill_id', 'transactions');
select _repoint_fk('purchase_replacements', 'bill_id', 'transactions');
select _repoint_fk('purchase_writeoffs', 'bill_id', 'transactions');
select _repoint_fk('goods_receipt_notes', 'bill_id', 'transactions');

drop function _repoint_fk(regclass, name, regclass, name);

-- ============================================================
-- 4. ar_invoice_remaining/ap_bill_remaining -- retarget ke transactions. Reducer
--    ar_bad_debt_writeoffs TETAP dipertahankan (ketauan review: tabelnya dibekukan bukan
--    didrop, kalau reducer ini dicabut baris histori yang udah di-write-off bakal "hidup
--    lagi" outstanding-nya). Signature gak berubah.
-- ============================================================

create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from ar_payments where invoice_id = p_invoice_id
      ), 0)
    - coalesce((
        select sum(amount) from ar_credit_notes where invoice_id = p_invoice_id
      ), 0)
    - coalesce((
        select sum(ada.amount) from ar_deposit_applications ada
        where ada.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    - coalesce((
        -- ar_bad_debt_writeoffs DIBEKUKAN (RPC-nya dicabut, gak ada write-off baru), tapi
        -- tabelnya SENGAJA belum didrop -- reducer ini tetap dipertahankan biar baris histori
        -- (2 demo) yang udah di-write-off gak "hidup lagi" outstanding-nya begitu ada trigger
        -- lain nyentuh invoice yang sama (ketauan review sebelum apply). Dihapus beneran nanti
        -- bareng migration cleanup yang drop ar_bad_debt_writeoffs.
        select sum(abw.amount) from ar_bad_debt_writeoffs abw
        where abw.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = abw.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(arc.amount) from ar_return_credits arc
        join ar_credit_notes acn on acn.id = arc.credit_note_id
        where acn.invoice_id = p_invoice_id
      ), 0)
    + coalesce((
        select sum(wr.discount_reversed_amount - wr.return_credit_settled_amount)
        from warranty_replacements wr
        join ar_credit_notes cn on cn.id = wr.credit_note_id
        where cn.invoice_id = p_invoice_id
      ), 0)
  from transactions ai
  where ai.id = p_invoice_id;
$$ language sql stable;

create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from ap_payments where bill_id = p_bill_id), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
    - coalesce((
        select sum(ada.amount) from ap_deposit_applications ada
        where ada.bill_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(arc.amount) from ap_return_credits arc
        join ap_credit_notes acn on acn.id = arc.credit_note_id
        where acn.bill_id = p_bill_id
      ), 0)
  from transactions ab
  where ab.id = p_bill_id;
$$ language sql stable;

-- ============================================================
-- 5. Guard/no_over_return -- retarget lookup ar_invoices/ap_bills ke transactions.
--    Signature gak berubah di semuanya (aman create or replace).
-- ============================================================

create or replace function ar_credit_notes_no_over_return() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_already_returned numeric;
  v_invoice_ref text;
begin
  select amount into v_invoice_amount from transactions where id = new.invoice_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from ar_credit_notes where invoice_id = new.invoice_id;

  if v_already_returned + new.amount > v_invoice_amount then
    select source_ref into v_invoice_ref from transactions where id = new.invoice_id;
    raise exception 'Retur invoice % melebihi nilai invoice (invoice %, sudah diretur %, coba retur %)',
      v_invoice_ref, v_invoice_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function ap_credit_notes_no_over_return() returns trigger as $$
declare
  v_bill_amount numeric;
  v_already_returned numeric;
  v_bill_ref text;
begin
  select amount into v_bill_amount from transactions where id = new.bill_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from ap_credit_notes where bill_id = new.bill_id;

  if v_already_returned + new.amount > v_bill_amount then
    select source_ref into v_bill_ref from transactions where id = new.bill_id;
    raise exception 'Retur bill % melebihi nilai bill (bill %, sudah diretur %, coba retur %)',
      v_bill_ref, v_bill_amount, v_already_returned, new.amount;
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
  select counterparty_id, journal_entry_id into v_invoice_customer_id, v_invoice_journal_entry_id
    from transactions where id = new.invoice_id;

  if v_invoice_customer_id is distinct from v_deposit_customer_id then
    select source_ref into v_deposit_ref from ar_deposits where id = new.deposit_id;
    select source_ref into v_invoice_ref from transactions where id = new.invoice_id;
    raise exception 'Deposit % milik customer lain — gak bisa diterapkan ke invoice %', v_deposit_ref, v_invoice_ref;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_invoice_journal_entry_id
  ) into v_invoice_cancelled;

  if v_invoice_cancelled then
    select source_ref into v_invoice_ref from transactions where id = new.invoice_id;
    raise exception 'Invoice % udah dibatalkan — gak bisa diterapkan DP ke situ', v_invoice_ref;
  end if;

  select ar_invoice_remaining(new.invoice_id) into v_invoice_remaining;

  if new.amount > v_invoice_remaining then
    select source_ref into v_invoice_ref from transactions where id = new.invoice_id;
    raise exception 'Penerapan deposit ke invoice % melebihi sisa piutang (sisa %, coba terapkan %)',
      v_invoice_ref, v_invoice_remaining, new.amount;
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
  select counterparty_id, journal_entry_id into v_bill_supplier_id, v_bill_journal_entry_id
    from transactions where id = new.bill_id;

  if v_bill_supplier_id is distinct from v_deposit_supplier_id then
    select source_ref into v_deposit_ref from ap_deposits where id = new.deposit_id;
    select source_ref into v_bill_ref from transactions where id = new.bill_id;
    raise exception 'Deposit % milik supplier lain -- gak bisa diterapkan ke bill %', v_deposit_ref, v_bill_ref;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_bill_journal_entry_id
  ) into v_bill_cancelled;

  if v_bill_cancelled then
    select source_ref into v_bill_ref from transactions where id = new.bill_id;
    raise exception 'Bill % udah dibatalkan -- gak bisa diterapkan DP ke situ', v_bill_ref;
  end if;

  select ap_bill_remaining(new.bill_id) into v_bill_remaining;

  if new.amount > v_bill_remaining then
    select source_ref into v_bill_ref from transactions where id = new.bill_id;
    raise exception 'Penerapan deposit ke bill % melebihi sisa utang (sisa %, coba terapkan %)',
      v_bill_ref, v_bill_remaining, new.amount;
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
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tukar barang per item', v_bill_ref;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
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
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok per item', v_bill_ref;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

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
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tulis-jadi-beban per item', v_bill_ref;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
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

-- ============================================================
-- 6. RPC yang beroperasi ke invoice/bill YANG SUDAH ADA -- retarget lookup ke
--    transactions. Guard ar_bad_debt_writeoffs di cancel_ar_invoice TETAP dipertahankan,
--    sama alasan poin 4 di atas (tabel dibekukan bukan didrop).
--    Signature gak berubah di semuanya (aman create or replace).
-- ============================================================

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
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
    raise exception 'Invoice % udah punya payment — gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
  end if;

  -- ar_bad_debt_writeoffs dibekukan (gak ada write-off baru), tapi guard ini dipertahankan
  -- buat baris histori (2 demo) yang udah pernah di-write-off -- konsisten sama keputusan
  -- di ar_invoice_remaining di atas.
  select count(*) into v_written_off_count
  from ar_bad_debt_writeoffs where invoice_id = p_invoice_id;

  if v_written_off_count > 0 then
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
    raise exception 'Invoice % udah punya % write-off piutang tak tertagih — gak bisa dibatalkan lewat jalur ini', v_invoice_ref, v_written_off_count;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_invoice_id;

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
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from ap_credit_notes where bill_id = p_bill_id;

  if v_credit_note_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from transactions where id = p_bill_id;

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

  insert into ar_credit_notes (invoice_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values (p_invoice_id, p_credit_note_date, p_source_ref, p_amount, v_entry_id, auth.uid())
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

  insert into ap_credit_notes (bill_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values (p_bill_id, p_credit_note_date, p_source_ref, v_effective_amount, v_entry_id, auth.uid())
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

    insert into ap_return_credits (supplier_id, credit_note_id, amount, journal_entry_id, created_by)
    values (v_supplier_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  return v_credit_note_id;
end;
$$;

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
    select source_ref into v_invoice_ref from transactions where id = p_invoice_id;
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
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
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

-- ============================================================
-- 7. Unify recompute_ar_invoice_status+recompute_ap_bill_status jadi 1 fungsi
--    recompute_transaction_status -- cabang by type, cabut cabang 'dihapusbukukan'
--    (write-off gak lagi ada). 12 trigger wrapper existing di-create-or-replace
--    manggil fungsi baru ini (nama trigger objects sendiri gak berubah). Baru abis
--    itu 2 fungsi lama didrop -- plpgsql gak validasi keberadaan callee pas CREATE,
--    tapi urutan ini dijaga biar gak ada jendela dead-reference.
-- ============================================================

create function recompute_transaction_status(p_transaction_id uuid) returns void as $$
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

  if v_type = 'INBOUND' then
    v_outstanding := ar_invoice_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_returned
      from ar_credit_notes where invoice_id = p_transaction_id;

    select coalesce(sum(amount), 0) into v_allocated
      from ar_payments where invoice_id = p_transaction_id;

    select coalesce(sum(amount), 0) into v_deposit_applied
      from ar_deposit_applications where invoice_id = p_transaction_id;

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
      ) then 'sales_order'
      else 'goods_issue'
    end;

    update transactions
      set outstanding = v_outstanding, returned = v_returned, status = v_status, origin = v_origin
      where id = p_transaction_id;
  else
    v_outstanding := ap_bill_remaining(p_transaction_id);

    select coalesce(sum(amount), 0) into v_allocated
      from ap_payments where bill_id = p_transaction_id;

    -- Beda dari AR: deposit_applied di sini SENGAJA exclude yang reversed (persis
    -- ap_bills_with_status 0032/0038 dulu) -- asimetri ini bukan kelalaian, disalin
    -- apa adanya dari recompute_ap_bill_status.
    select coalesce(sum(ada.amount), 0) into v_deposit_applied
      from ap_deposit_applications ada
      where ada.bill_id = p_transaction_id
        and not exists (select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id);

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when exists (select 1 from goods_receipt_notes grn where grn.bill_id = p_transaction_id) then 'grn'
      else 'langsung'
    end;

    update transactions
      set outstanding = v_outstanding, status = v_status, origin = v_origin
      where id = p_transaction_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function ar_payments_sync_invoice_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.invoice_id);
  return new;
end;
$$ language plpgsql;

create or replace function ar_credit_notes_sync_invoice_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.invoice_id);
  return new;
end;
$$ language plpgsql;

create or replace function ar_return_credits_sync_invoice_status() returns trigger as $$
declare
  v_invoice_id uuid;
begin
  select invoice_id into v_invoice_id from ar_credit_notes where id = new.credit_note_id;
  if v_invoice_id is not null then
    perform recompute_transaction_status(v_invoice_id);
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function warranty_replacements_sync_invoice_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.invoice_id);
  return new;
end;
$$ language plpgsql;

create or replace function goods_issues_sync_invoice_status() returns trigger as $$
begin
  if new.invoice_id is not null then
    perform recompute_transaction_status(new.invoice_id);
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function goods_issue_lines_sync_invoice_origin() returns trigger as $$
declare
  v_invoice_id uuid;
begin
  select invoice_id into v_invoice_id from goods_issues where id = new.goods_issue_id;
  if v_invoice_id is not null then
    perform recompute_transaction_status(v_invoice_id);
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function ar_deposit_applications_sync_deposit_status() returns trigger as $$
begin
  perform recompute_ar_deposit_status(new.deposit_id);
  perform recompute_transaction_status(new.invoice_id);
  return new;
end;
$$ language plpgsql;

create or replace function ap_payments_sync_bill_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.bill_id);
  return new;
end;
$$ language plpgsql;

create or replace function ap_credit_notes_sync_bill_status() returns trigger as $$
begin
  perform recompute_transaction_status(new.bill_id);
  return new;
end;
$$ language plpgsql;

create or replace function ap_return_credits_sync_bill_status() returns trigger as $$
declare
  v_bill_id uuid;
begin
  select bill_id into v_bill_id from ap_credit_notes where id = new.credit_note_id;
  if v_bill_id is not null then
    perform recompute_transaction_status(v_bill_id);
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function goods_receipt_notes_sync_bill_status() returns trigger as $$
begin
  if new.bill_id is not null then
    perform recompute_transaction_status(new.bill_id);
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function ap_deposit_applications_sync_deposit_status() returns trigger as $$
begin
  perform recompute_ap_deposit_status(new.deposit_id);
  perform recompute_transaction_status(new.bill_id);
  return new;
end;
$$ language plpgsql;

create or replace function journal_entries_sync_reversal_status() returns trigger as $$
declare
  v_id uuid;
begin
  if new.reverses_entry_id is null then
    return new;
  end if;

  for v_id in select id from transactions where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;

  update pos_sales set status = 'dibatalkan' where revenue_journal_entry_id = new.reverses_entry_id;

  for v_id in select invoice_id from ar_deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;
  for v_id in select deposit_id from ar_deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_ar_deposit_status(v_id);
  end loop;

  for v_id in select bill_id from ap_deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;
  for v_id in select deposit_id from ap_deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_ap_deposit_status(v_id);
  end loop;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop function recompute_ar_invoice_status(uuid);
drop function recompute_ap_bill_status(uuid);

-- ============================================================
-- 8. create_goods_issue/create_goods_receipt -- ganti pemanggilan internal dari
--    create_ar_invoice/create_ap_bill ke create_transaction (0063). Signature
--    eksternal ke-2 fungsi ini TIDAK berubah -- jurnal HPP/Persediaan-nya sendiri
--    (terpisah dari create_transaction) sama sekali gak kesentuh.
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
    'INBOUND', p_customer_id, p_invoice_date, p_description, p_source_ref,
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
    'OUTBOUND', v_supplier_id, p_receipt_date, p_bill_description, p_bill_source_ref,
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
-- 9. Redefinisi ar_invoices_with_status/ap_bills_with_status -- filter type di atas
--    transactions, gantiin select polos dari ar_invoices/ap_bills. Nama & urutan
--    kolom PERSIS sama (syarat CREATE OR REPLACE VIEW) biar queries.ts existing
--    gak perlu diubah -- mirror deviasi "2 view tetap terpisah" yang sama dipakai
--    orders (0060). outstanding/returned di-cast ::numeric (bukan numeric(14,2))
--    biar cocok typmod kolom lama (0053 sengaja pakai numeric polos di ar_invoices/
--    ap_bills, sementara transactions/0063 declare numeric(14,2) buat storage) --
--    tanpa cast ini CREATE OR REPLACE VIEW gagal "cannot change data type of view
--    column".
-- ============================================================

create or replace view ar_invoices_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as customer_id, date as invoice_date, due_date, description, source_ref, amount,
  journal_entry_id, created_at, outstanding::numeric as outstanding, returned::numeric as returned,
  status, origin
from transactions
where type = 'INBOUND';

create or replace view ap_bills_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as supplier_id, date as bill_date, due_date, description, source_ref, supplier_document_ref,
  amount, journal_entry_id, created_at, outstanding::numeric as outstanding, status, origin
from transactions
where type = 'OUTBOUND';
