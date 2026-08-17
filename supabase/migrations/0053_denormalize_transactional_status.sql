-- Denormalisasi status/origin/outstanding transaksional ke kolom asli, gantiin 7 view
-- (`*_with_status`, migration 0031-0038) yang selama ini ngitung ulang status LEWAT
-- correlated lateral subquery, per baris, tiap kali halaman daftar dibuka -- termasuk
-- tiap kali dibuka TANPA filter tanggal (default filter di semua page.tsx kosong), jadi
-- ngitung ulang status SELURUH isi tabel tiap load. Karena data transaksional ERP ini
-- append-only (gak pernah dihapus/diedit, cuma nambah terus), biaya ini naik terus tanpa
-- batas seiring waktu -- gak kerasa sekarang (data masih sedikit), tapi gak ada titik
-- stabilnya.
--
-- Pendekatan: status/origin/outstanding sekarang KOLOM ASLI di tabel header, dijaga
-- otomatis lewat trigger tiap ada insert di tabel terkait (pembayaran, DP, retur,
-- writeoff, pembatalan lewat jurnal pembalik) -- bukan dihitung ulang tiap read. Semua
-- tabel anak yang jadi sumber hitungan ini SENGAJA insert-only (gak pernah di-UPDATE/
-- DELETE di RPC manapun, diverifikasi lewat grep migration) -- jadi cukup trigger AFTER
-- INSERT, gak perlu jaga kasus UPDATE/DELETE.
--
-- Formula CASE/status di tiap fungsi recompute_* di bawah ini SENGAJA disalin PERSIS dari
-- definisi view yang digantikannya (0031-0038) -- bukan ditulis ulang dari nol -- biar gak
-- ada drift perilaku. Fungsi `_remaining()` yang udah ada (`ar_invoice_remaining`,
-- `ap_bill_remaining`, `ar_deposit_remaining`, `ap_deposit_remaining`) TETAP dipakai apa
-- adanya sebagai sumber kebenaran tunggal buat angka outstanding/remaining, cuma sekarang
-- dipanggil sekali per kejadian tulis, bukan sekali per baris per read.
--
-- Kenapa fungsi recompute_* SECURITY DEFINER: ar_invoices/ap_bills/pos_sales/ap_deposits/
-- ar_deposits cuma punya grant (select, insert) buat authenticated -- SENGAJA gak ada
-- grant update sama sekali (header transaksi immutable by design, lihat
-- memory/preferences/system/state-naming-convention.md). Trigger yang mau nulis kolom
-- status/origin/outstanding butuh privilege lebih dari itu. Pola SECURITY DEFINER buat
-- kasus kayak gini bukan hal baru di project ini (create_pos_sale, migration 0009, RPC
-- security definer pertama). purchase_orders/sales_orders sebenarnya UDAH punya grant
-- update (migration 0024, buat cancelled_at) tapi tetap dibikin SECURITY DEFINER juga
-- biar seragam -- gak gantung ke asumsi role admin/accountant selalu sama antara insert
-- & update policy.
--
-- Kenapa 5 tabel (ar_invoices/ap_bills/ap_deposits/ar_deposits/pos_sales) juga dapat
-- trigger block_edit_delete BARU: ke-5 tabel ini SEBELUMNYA dipasangi trigger
-- block_edit_delete() generik (0003/0005/0006/0009) yang nolak SEMUA update tanpa
-- terkecuali -- termasuk UPDATE yang ditulis migration ini sendiri buat ngisi kolom
-- status/origin/outstanding/remaining/total. Diganti jadi versi selective (pola yang
-- sama kayak purchase_orders_block_edit_delete_or_cancel, 0024): kolom bisnis asli TETAP
-- gak bisa diubah, cuma kolom baru migration ini yang boleh.
--
-- Kenapa kolom outstanding/returned/remaining/total dibiarin `numeric` polos (bukan
-- numeric(14,2) kayak kolom uang lain di project ini): CREATE OR REPLACE VIEW di bagian
-- paling bawah file ini WAJIB hasilin tipe kolom yang PERSIS sama kayak view lama
-- (0031-0038) -- dan tipe kolom itu aslinya juga `numeric` polos (hasil SUM()/fungsi
-- _remaining(), yang keduanya returns numeric tanpa scale). Declare numeric(14,2) di
-- sini bakal bikin CREATE OR REPLACE VIEW gagal "cannot change data type of view column".
-- Bukan kelalaian, dipaksa constraint ini.

-- ============================================================
-- AR INVOICES (status + origin + outstanding + returned)
-- ============================================================

alter table ar_invoices
  add column outstanding numeric not null default 0,
  add column returned numeric not null default 0,
  add column status text not null default 'belum',
  add column origin text not null default 'financial_only';

create index ar_invoices_status_idx on ar_invoices(status);
create index ar_invoices_origin_idx on ar_invoices(origin);

-- ar_invoices_block_edit_delete (0005) generik nolak SEMUA update, bukan cuma ke kolom
-- bisnis -- bakal nolak UPDATE recompute_ar_invoice_status() di bawah juga. Ganti jadi
-- selective (niru pola purchase_orders_block_edit_delete_or_cancel, 0024): kolom bisnis
-- asli TETAP immutable, cuma outstanding/returned/status/origin (kolom baru migration ini)
-- yang boleh berubah, karena sekarang dijaga trigger otomatis bukan dihitung ulang tiap read.
drop trigger ar_invoices_block_edit_delete on ar_invoices;

create function ar_invoices_block_edit_delete_or_sync() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ar_invoices gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  if (old.customer_id, old.invoice_date, old.due_date, old.description, old.source_ref,
      old.amount, old.journal_entry_id, old.created_by, old.created_at)
     is distinct from
     (new.customer_id, new.invoice_date, new.due_date, new.description, new.source_ref,
      new.amount, new.journal_entry_id, new.created_by, new.created_at) then
    raise exception 'ar_invoices gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_invoices_block_edit_delete
  before update or delete on ar_invoices
  for each row execute function ar_invoices_block_edit_delete_or_sync();

-- Nilai awal pas insert: belum ada payment/DP/retur/writeoff/goods_issue apa pun,
-- outstanding = amount penuh. goods_issues/goods_issue_lines (kalau ada) selalu di-insert
-- SETELAH ar_invoices ini (create_goods_issue manggil create_ar_invoice duluan, migration
-- 0024) -- jadi origin bakal dikoreksi oleh trigger goods_issues/goods_issue_lines di
-- bawah, dalam transaksi yang sama, sebelum commit.
create function ar_invoices_set_defaults() returns trigger as $$
begin
  new.outstanding := new.amount;
  new.returned := 0;
  new.status := 'belum';
  new.origin := 'financial_only';
  return new;
end;
$$ language plpgsql;

create trigger ar_invoices_set_defaults_trigger
  before insert on ar_invoices
  for each row execute function ar_invoices_set_defaults();

create function recompute_ar_invoice_status(p_invoice_id uuid) returns void as $$
declare
  v_journal_entry_id uuid;
  v_outstanding numeric;
  v_returned numeric;
  v_is_cancelled boolean;
  v_allocated numeric;
  v_deposit_applied numeric;
  v_written_off numeric;
  v_status text;
  v_origin text;
begin
  select journal_entry_id into v_journal_entry_id from ar_invoices where id = p_invoice_id;
  if not found then
    return;
  end if;

  v_outstanding := ar_invoice_remaining(p_invoice_id);

  select coalesce(sum(amount), 0) into v_returned
    from ar_credit_notes where invoice_id = p_invoice_id;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_journal_entry_id
  ) into v_is_cancelled;

  select coalesce(sum(amount), 0) into v_allocated
    from ar_payments where invoice_id = p_invoice_id;

  select coalesce(sum(amount), 0) into v_deposit_applied
    from ar_deposit_applications where invoice_id = p_invoice_id;

  select coalesce(sum(amount), 0) into v_written_off
    from ar_bad_debt_writeoffs where invoice_id = p_invoice_id;

  -- Persis CASE ar_invoices_with_status (0033) -- allocated/deposit_applied SENGAJA raw sum
  -- tanpa filter reversal di sini (beda dari outstanding via ar_invoice_remaining yang
  -- filter reversal), matching invoiceStatus() client.
  v_status := case
    when v_is_cancelled then 'dibatalkan'
    when v_written_off > 0 and v_outstanding <= 0.005 then 'dihapusbukukan'
    when v_outstanding <= 0.005 then 'lunas'
    when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
    else 'belum'
  end;

  v_origin := case
    when not exists (select 1 from goods_issues gi where gi.invoice_id = p_invoice_id) then 'financial_only'
    when exists (
      select 1 from goods_issues gi
      join goods_issue_lines gil on gil.goods_issue_id = gi.id
      where gi.invoice_id = p_invoice_id and gil.so_line_id is not null
    ) then 'sales_order'
    else 'goods_issue'
  end;

  update ar_invoices
    set outstanding = v_outstanding, returned = v_returned, status = v_status, origin = v_origin
    where id = p_invoice_id;
end;
$$ language plpgsql security definer set search_path = public;

create function ar_payments_sync_invoice_status() returns trigger as $$
begin
  perform recompute_ar_invoice_status(new.invoice_id);
  return new;
end;
$$ language plpgsql;

create trigger ar_payments_sync_invoice_status_trigger
  after insert on ar_payments
  for each row execute function ar_payments_sync_invoice_status();

create function ar_credit_notes_sync_invoice_status() returns trigger as $$
begin
  perform recompute_ar_invoice_status(new.invoice_id);
  return new;
end;
$$ language plpgsql;

create trigger ar_credit_notes_sync_invoice_status_trigger
  after insert on ar_credit_notes
  for each row execute function ar_credit_notes_sync_invoice_status();

-- (ar_deposit_applications insert juga ubah outstanding ar_invoices, bukan cuma remaining
-- ar_deposits -- ditangani 1 trigger gabungan di bagian AR Deposits di bawah,
-- ar_deposit_applications_sync_deposit_status_trigger, biar gak recompute invoice 2x.)

create function ar_bad_debt_writeoffs_sync_invoice_status() returns trigger as $$
begin
  perform recompute_ar_invoice_status(new.invoice_id);
  return new;
end;
$$ language plpgsql;

create trigger ar_bad_debt_writeoffs_sync_invoice_status_trigger
  after insert on ar_bad_debt_writeoffs
  for each row execute function ar_bad_debt_writeoffs_sync_invoice_status();

-- ar_return_credits/warranty_replacements gak punya invoice_id langsung -- ikut
-- ar_invoice_remaining() (0028), resolve lewat credit_note_id -> ar_credit_notes.invoice_id.
create function ar_return_credits_sync_invoice_status() returns trigger as $$
declare
  v_invoice_id uuid;
begin
  select invoice_id into v_invoice_id from ar_credit_notes where id = new.credit_note_id;
  if v_invoice_id is not null then
    perform recompute_ar_invoice_status(v_invoice_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger ar_return_credits_sync_invoice_status_trigger
  after insert on ar_return_credits
  for each row execute function ar_return_credits_sync_invoice_status();

create function warranty_replacements_sync_invoice_status() returns trigger as $$
declare
  v_invoice_id uuid;
begin
  select invoice_id into v_invoice_id from ar_credit_notes where id = new.credit_note_id;
  if v_invoice_id is not null then
    perform recompute_ar_invoice_status(v_invoice_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger warranty_replacements_sync_invoice_status_trigger
  after insert on warranty_replacements
  for each row execute function warranty_replacements_sync_invoice_status();

create function goods_issues_sync_invoice_status() returns trigger as $$
begin
  if new.invoice_id is not null then
    perform recompute_ar_invoice_status(new.invoice_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_issues_sync_invoice_status_trigger
  after insert on goods_issues
  for each row execute function goods_issues_sync_invoice_status();

-- goods_issue_lines insert -- dampak ke 2 hal independen: origin AR Invoice (so_line_id
-- null/not-null nentuin 'goods_issue' vs 'sales_order') DAN status Sales Order (lihat
-- bagian Sales Order di bawah) -- 2 trigger terpisah, masing-masing 1 concern.
create function goods_issue_lines_sync_invoice_origin() returns trigger as $$
declare
  v_invoice_id uuid;
begin
  select invoice_id into v_invoice_id from goods_issues where id = new.goods_issue_id;
  if v_invoice_id is not null then
    perform recompute_ar_invoice_status(v_invoice_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_issue_lines_sync_invoice_origin_trigger
  after insert on goods_issue_lines
  for each row execute function goods_issue_lines_sync_invoice_origin();

-- ============================================================
-- AP BILLS (status + origin + outstanding)
-- ============================================================

alter table ap_bills
  add column outstanding numeric not null default 0,
  add column status text not null default 'belum',
  add column origin text not null default 'langsung';

create index ap_bills_status_idx on ap_bills(status);
create index ap_bills_origin_idx on ap_bills(origin);

-- Sama kayak ar_invoices di atas -- ap_bills_block_edit_delete (0006) generik diganti
-- selective, biar UPDATE recompute_ap_bill_status() gak ketolak.
drop trigger ap_bills_block_edit_delete on ap_bills;

create function ap_bills_block_edit_delete_or_sync() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ap_bills gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  if (old.supplier_id, old.bill_date, old.due_date, old.description, old.source_ref,
      old.supplier_document_ref, old.amount, old.journal_entry_id, old.created_by, old.created_at)
     is distinct from
     (new.supplier_id, new.bill_date, new.due_date, new.description, new.source_ref,
      new.supplier_document_ref, new.amount, new.journal_entry_id, new.created_by, new.created_at) then
    raise exception 'ap_bills gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_bills_block_edit_delete
  before update or delete on ap_bills
  for each row execute function ap_bills_block_edit_delete_or_sync();

-- goods_receipt_notes (kalau ada) selalu di-insert SETELAH ap_bills ini (create_goods_receipt
-- manggil create_ap_bill duluan) -- origin dikoreksi trigger goods_receipt_notes di bawah,
-- transaksi yang sama, sebelum commit.
create function ap_bills_set_defaults() returns trigger as $$
begin
  new.outstanding := new.amount;
  new.status := 'belum';
  new.origin := 'langsung';
  return new;
end;
$$ language plpgsql;

create trigger ap_bills_set_defaults_trigger
  before insert on ap_bills
  for each row execute function ap_bills_set_defaults();

create function recompute_ap_bill_status(p_bill_id uuid) returns void as $$
declare
  v_journal_entry_id uuid;
  v_outstanding numeric;
  v_is_cancelled boolean;
  v_allocated numeric;
  v_deposit_applied numeric;
  v_status text;
  v_origin text;
begin
  select journal_entry_id into v_journal_entry_id from ap_bills where id = p_bill_id;
  if not found then
    return;
  end if;

  v_outstanding := ap_bill_remaining(p_bill_id);

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_journal_entry_id
  ) into v_is_cancelled;

  select coalesce(sum(amount), 0) into v_allocated
    from ap_payments where bill_id = p_bill_id;

  -- Beda dari AR: deposit_applied di sini SENGAJA exclude yang reversed (persis
  -- ap_bills_with_status 0032/0038) -- asimetri ini bukan kelalaian, disalin apa adanya.
  select coalesce(sum(ada.amount), 0) into v_deposit_applied
    from ap_deposit_applications ada
    where ada.bill_id = p_bill_id
      and not exists (select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id);

  v_status := case
    when v_is_cancelled then 'dibatalkan'
    when v_outstanding <= 0.005 then 'lunas'
    when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
    else 'belum'
  end;

  v_origin := case
    when exists (select 1 from goods_receipt_notes grn where grn.bill_id = p_bill_id) then 'grn'
    else 'langsung'
  end;

  update ap_bills
    set outstanding = v_outstanding, status = v_status, origin = v_origin
    where id = p_bill_id;
end;
$$ language plpgsql security definer set search_path = public;

create function ap_payments_sync_bill_status() returns trigger as $$
begin
  perform recompute_ap_bill_status(new.bill_id);
  return new;
end;
$$ language plpgsql;

create trigger ap_payments_sync_bill_status_trigger
  after insert on ap_payments
  for each row execute function ap_payments_sync_bill_status();

create function ap_credit_notes_sync_bill_status() returns trigger as $$
begin
  perform recompute_ap_bill_status(new.bill_id);
  return new;
end;
$$ language plpgsql;

create trigger ap_credit_notes_sync_bill_status_trigger
  after insert on ap_credit_notes
  for each row execute function ap_credit_notes_sync_bill_status();

-- (ap_deposit_applications insert juga ubah outstanding ap_bills, bukan cuma remaining
-- ap_deposits -- ditangani 1 trigger gabungan di bagian AP Deposits di bawah,
-- ap_deposit_applications_sync_deposit_status_trigger, biar gak recompute bill 2x.)

-- ap_return_credits gak punya bill_id langsung -- ikut ap_bill_remaining() (0010), resolve
-- lewat credit_note_id -> ap_credit_notes.bill_id.
create function ap_return_credits_sync_bill_status() returns trigger as $$
declare
  v_bill_id uuid;
begin
  select bill_id into v_bill_id from ap_credit_notes where id = new.credit_note_id;
  if v_bill_id is not null then
    perform recompute_ap_bill_status(v_bill_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger ap_return_credits_sync_bill_status_trigger
  after insert on ap_return_credits
  for each row execute function ap_return_credits_sync_bill_status();

create function goods_receipt_notes_sync_bill_status() returns trigger as $$
begin
  if new.bill_id is not null then
    perform recompute_ap_bill_status(new.bill_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_receipt_notes_sync_bill_status_trigger
  after insert on goods_receipt_notes
  for each row execute function goods_receipt_notes_sync_bill_status();

-- ============================================================
-- PURCHASE ORDERS (status, QTY-based per baris)
-- ============================================================

alter table purchase_orders add column status text not null default 'OPEN';
create index purchase_orders_status_idx on purchase_orders(status);

create function recompute_purchase_order_status(p_purchase_order_id uuid) returns void as $$
declare
  v_cancelled_at timestamptz;
  v_all_received boolean;
  v_none_received boolean;
  v_status text;
begin
  select cancelled_at into v_cancelled_at from purchase_orders where id = p_purchase_order_id;
  if not found then
    return;
  end if;

  -- purchase_orders_block_edit_delete_or_cancel (0024) nolak SEMUA update begitu
  -- cancelled_at kepasang (bukan cuma kolom bisnis) -- PO yang udah dibatalkan gak boleh
  -- kena UPDATE apa pun lagi, termasuk dari fungsi ini (backfill loop di bawah nyentuh
  -- SEMUA baris tanpa pandang status). Statusnya udah pasti 'CANCELLED' (di-set langsung
  -- sama purchase_orders_sync_status_on_cancel_trigger pas cancel_purchase_order jalan),
  -- jadi aman skip.
  if v_cancelled_at is not null then
    return;
  end if;

  -- Persis lateral aggregate purchase_orders_with_status (0034).
  select
    coalesce(bool_and(coalesce(gr.received, 0) >= pol.qty_ordered - 0.0005), true),
    coalesce(bool_and(coalesce(gr.received, 0) <= 0.0005), true)
    into v_all_received, v_none_received
  from purchase_order_lines pol
  left join lateral (
    select sum(grl.qty_received) as received
    from goods_receipt_lines grl
    where grl.po_line_id = pol.id
  ) gr on true
  where pol.purchase_order_id = p_purchase_order_id;

  v_status := case
    when v_cancelled_at is not null then 'CANCELLED'
    when v_all_received then 'FULLY_RECEIVED'
    when v_none_received then 'OPEN'
    else 'PARTIALLY_RECEIVED'
  end;

  update purchase_orders set status = v_status where id = p_purchase_order_id;
end;
$$ language plpgsql security definer set search_path = public;

create function purchase_order_lines_sync_po_status() returns trigger as $$
begin
  perform recompute_purchase_order_status(new.purchase_order_id);
  return new;
end;
$$ language plpgsql;

create trigger purchase_order_lines_sync_po_status_trigger
  after insert on purchase_order_lines
  for each row execute function purchase_order_lines_sync_po_status();

create function goods_receipt_lines_sync_po_status() returns trigger as $$
declare
  v_purchase_order_id uuid;
begin
  select purchase_order_id into v_purchase_order_id
    from purchase_order_lines where id = new.po_line_id;
  if v_purchase_order_id is not null then
    perform recompute_purchase_order_status(v_purchase_order_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_receipt_lines_sync_po_status_trigger
  after insert on goods_receipt_lines
  for each row execute function goods_receipt_lines_sync_po_status();

-- Pembatalan lewat cancel_purchase_order (0024) cuma nyentuh cancelled_at, gak ada baris
-- baru di goods_receipt_lines -- butuh trigger sendiri di update cancelled_at. Cancelled
-- SELALU menang di CASE apa pun kondisi qty-nya, jadi cukup set langsung (gak perlu
-- panggil recompute_purchase_order_status ulang).
create function purchase_orders_sync_status_on_cancel() returns trigger as $$
begin
  if new.cancelled_at is not null and old.cancelled_at is null then
    new.status := 'CANCELLED';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger purchase_orders_sync_status_on_cancel_trigger
  before update on purchase_orders
  for each row execute function purchase_orders_sync_status_on_cancel();

-- ============================================================
-- SALES ORDERS (status, QTY-based per baris) -- mirror persis Purchase Order
-- ============================================================

alter table sales_orders add column status text not null default 'OPEN';
create index sales_orders_status_idx on sales_orders(status);

create function recompute_sales_order_status(p_sales_order_id uuid) returns void as $$
declare
  v_cancelled_at timestamptz;
  v_all_issued boolean;
  v_none_issued boolean;
  v_status text;
begin
  select cancelled_at into v_cancelled_at from sales_orders where id = p_sales_order_id;
  if not found then
    return;
  end if;

  -- Sama alasan kayak recompute_purchase_order_status di atas --
  -- sales_orders_block_edit_delete_or_cancel (0024) nolak SEMUA update begitu
  -- cancelled_at kepasang.
  if v_cancelled_at is not null then
    return;
  end if;

  -- Persis lateral aggregate sales_orders_with_status (0035).
  select
    coalesce(bool_and(coalesce(gi.issued, 0) >= sol.qty_ordered - 0.0005), true),
    coalesce(bool_and(coalesce(gi.issued, 0) <= 0.0005), true)
    into v_all_issued, v_none_issued
  from sales_order_lines sol
  left join lateral (
    select sum(gil.qty_issued) as issued
    from goods_issue_lines gil
    where gil.so_line_id = sol.id
  ) gi on true
  where sol.sales_order_id = p_sales_order_id;

  v_status := case
    when v_cancelled_at is not null then 'CANCELLED'
    when v_all_issued then 'FULLY_FULFILLED'
    when v_none_issued then 'OPEN'
    else 'PARTIALLY_FULFILLED'
  end;

  update sales_orders set status = v_status where id = p_sales_order_id;
end;
$$ language plpgsql security definer set search_path = public;

create function sales_order_lines_sync_so_status() returns trigger as $$
begin
  perform recompute_sales_order_status(new.sales_order_id);
  return new;
end;
$$ language plpgsql;

create trigger sales_order_lines_sync_so_status_trigger
  after insert on sales_order_lines
  for each row execute function sales_order_lines_sync_so_status();

-- Separuh kedua dari goods_issue_lines insert (separuh pertama: origin AR Invoice, di atas).
create function goods_issue_lines_sync_so_status() returns trigger as $$
declare
  v_sales_order_id uuid;
begin
  if new.so_line_id is null then
    return new;
  end if;
  select sales_order_id into v_sales_order_id
    from sales_order_lines where id = new.so_line_id;
  if v_sales_order_id is not null then
    perform recompute_sales_order_status(v_sales_order_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_issue_lines_sync_so_status_trigger
  after insert on goods_issue_lines
  for each row execute function goods_issue_lines_sync_so_status();

create function sales_orders_sync_status_on_cancel() returns trigger as $$
begin
  if new.cancelled_at is not null and old.cancelled_at is null then
    new.status := 'CANCELLED';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger sales_orders_sync_status_on_cancel_trigger
  before update on sales_orders
  for each row execute function sales_orders_sync_status_on_cancel();

-- ============================================================
-- POS SALES (status + total) -- paling simpel, cuma 2 kondisi status
-- ============================================================

alter table pos_sales
  add column total numeric not null default 0,
  add column status text not null default 'normal';

create index pos_sales_status_idx on pos_sales(status);

-- Sama alasan kayak ar_invoices/ap_bills di atas -- pos_sales_block_edit_delete (0009)
-- generik diganti selective, biar UPDATE total/status di bawah gak ketolak.
drop trigger pos_sales_block_edit_delete on pos_sales;

create function pos_sales_block_edit_delete_or_sync() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pos_sales gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  if (old.customer_id, old.sale_date, old.cash_account_id, old.revenue_account_id,
      old.revenue_journal_entry_id, old.cogs_journal_entry_id, old.source_ref,
      old.created_by, old.created_at)
     is distinct from
     (new.customer_id, new.sale_date, new.cash_account_id, new.revenue_account_id,
      new.revenue_journal_entry_id, new.cogs_journal_entry_id, new.source_ref,
      new.created_by, new.created_at) then
    raise exception 'pos_sales gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger pos_sales_block_edit_delete
  before update or delete on pos_sales
  for each row execute function pos_sales_block_edit_delete_or_sync();

create function pos_sale_lines_sync_total() returns trigger as $$
begin
  update pos_sales
    set total = (select coalesce(sum(line_amount), 0) from pos_sale_lines where pos_sale_id = new.pos_sale_id)
    where id = new.pos_sale_id;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger pos_sale_lines_sync_total_trigger
  after insert on pos_sale_lines
  for each row execute function pos_sale_lines_sync_total();

-- Pembatalan POS Sale (void_pos_sale, 0009) bikin jurnal pembalik, ditangani generik lewat
-- trigger journal_entries di bagian paling bawah file ini (satu tempat buat semua modul
-- yang "dibatalkan" lewat reversing entry).

-- ============================================================
-- AP DEPOSITS (status + remaining)
-- ============================================================

alter table ap_deposits
  add column remaining numeric not null default 0,
  add column status text not null default 'belum_dipakai';

create index ap_deposits_status_idx on ap_deposits(status);

-- Sama alasan kayak ar_invoices/ap_bills/pos_sales di atas -- ap_deposits_block_edit_delete
-- (0006) generik diganti selective, biar UPDATE recompute_ap_deposit_status() gak ketolak.
drop trigger ap_deposits_block_edit_delete on ap_deposits;

create function ap_deposits_block_edit_delete_or_sync() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ap_deposits gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  if (old.supplier_id, old.deposit_date, old.source_ref, old.amount, old.journal_entry_id,
      old.created_by, old.created_at)
     is distinct from
     (new.supplier_id, new.deposit_date, new.source_ref, new.amount, new.journal_entry_id,
      new.created_by, new.created_at) then
    raise exception 'ap_deposits gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_deposits_block_edit_delete
  before update or delete on ap_deposits
  for each row execute function ap_deposits_block_edit_delete_or_sync();

create function ap_deposits_set_defaults() returns trigger as $$
begin
  new.remaining := new.amount;
  return new;
end;
$$ language plpgsql;

create trigger ap_deposits_set_defaults_trigger
  before insert on ap_deposits
  for each row execute function ap_deposits_set_defaults();

create function recompute_ap_deposit_status(p_deposit_id uuid) returns void as $$
declare
  v_amount numeric;
  v_remaining numeric;
  v_status text;
begin
  select amount into v_amount from ap_deposits where id = p_deposit_id;
  if not found then
    return;
  end if;

  v_remaining := ap_deposit_remaining(p_deposit_id);

  v_status := case
    when v_remaining <= 0.005 then 'selesai'
    when v_remaining < v_amount then 'sebagian'
    else 'belum_dipakai'
  end;

  update ap_deposits set remaining = v_remaining, status = v_status where id = p_deposit_id;
end;
$$ language plpgsql security definer set search_path = public;

create function ap_deposit_applications_sync_deposit_status() returns trigger as $$
begin
  perform recompute_ap_deposit_status(new.deposit_id);
  perform recompute_ap_bill_status(new.bill_id);
  return new;
end;
$$ language plpgsql;

create trigger ap_deposit_applications_sync_deposit_status_trigger
  after insert on ap_deposit_applications
  for each row execute function ap_deposit_applications_sync_deposit_status();

create function ap_deposit_refunds_sync_deposit_status() returns trigger as $$
begin
  perform recompute_ap_deposit_status(new.deposit_id);
  return new;
end;
$$ language plpgsql;

create trigger ap_deposit_refunds_sync_deposit_status_trigger
  after insert on ap_deposit_refunds
  for each row execute function ap_deposit_refunds_sync_deposit_status();

create function ap_deposit_forfeitures_sync_deposit_status() returns trigger as $$
begin
  perform recompute_ap_deposit_status(new.deposit_id);
  return new;
end;
$$ language plpgsql;

create trigger ap_deposit_forfeitures_sync_deposit_status_trigger
  after insert on ap_deposit_forfeitures
  for each row execute function ap_deposit_forfeitures_sync_deposit_status();

-- ============================================================
-- AR DEPOSITS (status + remaining) -- mirror persis AP Deposits
-- ============================================================

alter table ar_deposits
  add column remaining numeric not null default 0,
  add column status text not null default 'belum_dipakai';

create index ar_deposits_status_idx on ar_deposits(status);

-- Sama alasan kayak ar_invoices/ap_bills/pos_sales/ap_deposits di atas --
-- ar_deposits_block_edit_delete (0005) generik diganti selective, biar UPDATE
-- recompute_ar_deposit_status() gak ketolak.
drop trigger ar_deposits_block_edit_delete on ar_deposits;

create function ar_deposits_block_edit_delete_or_sync() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ar_deposits gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  if (old.customer_id, old.deposit_date, old.source_ref, old.amount, old.journal_entry_id,
      old.created_by, old.created_at)
     is distinct from
     (new.customer_id, new.deposit_date, new.source_ref, new.amount, new.journal_entry_id,
      new.created_by, new.created_at) then
    raise exception 'ar_deposits gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_deposits_block_edit_delete
  before update or delete on ar_deposits
  for each row execute function ar_deposits_block_edit_delete_or_sync();

create function ar_deposits_set_defaults() returns trigger as $$
begin
  new.remaining := new.amount;
  return new;
end;
$$ language plpgsql;

create trigger ar_deposits_set_defaults_trigger
  before insert on ar_deposits
  for each row execute function ar_deposits_set_defaults();

create function recompute_ar_deposit_status(p_deposit_id uuid) returns void as $$
declare
  v_amount numeric;
  v_remaining numeric;
  v_status text;
begin
  select amount into v_amount from ar_deposits where id = p_deposit_id;
  if not found then
    return;
  end if;

  v_remaining := ar_deposit_remaining(p_deposit_id);

  v_status := case
    when v_remaining <= 0.005 then 'selesai'
    when v_remaining < v_amount then 'sebagian'
    else 'belum_dipakai'
  end;

  update ar_deposits set remaining = v_remaining, status = v_status where id = p_deposit_id;
end;
$$ language plpgsql security definer set search_path = public;

create function ar_deposit_applications_sync_deposit_status() returns trigger as $$
begin
  perform recompute_ar_deposit_status(new.deposit_id);
  perform recompute_ar_invoice_status(new.invoice_id);
  return new;
end;
$$ language plpgsql;

create trigger ar_deposit_applications_sync_deposit_status_trigger
  after insert on ar_deposit_applications
  for each row execute function ar_deposit_applications_sync_deposit_status();

create function ar_deposit_refunds_sync_deposit_status() returns trigger as $$
begin
  perform recompute_ar_deposit_status(new.deposit_id);
  return new;
end;
$$ language plpgsql;

create trigger ar_deposit_refunds_sync_deposit_status_trigger
  after insert on ar_deposit_refunds
  for each row execute function ar_deposit_refunds_sync_deposit_status();

create function ar_deposit_forfeitures_sync_deposit_status() returns trigger as $$
begin
  perform recompute_ar_deposit_status(new.deposit_id);
  return new;
end;
$$ language plpgsql;

create trigger ar_deposit_forfeitures_sync_deposit_status_trigger
  after insert on ar_deposit_forfeitures
  for each row execute function ar_deposit_forfeitures_sync_deposit_status();

-- ============================================================
-- Pembatalan via reversing journal entry -- SATU trigger di journal_entries buat semua
-- modul yang statusnya bisa berubah gara-gara ada entry baru yang reverses_entry_id-nya
-- nunjuk balik ke entry lama (AR Invoice, AP Bill, POS Sale langsung; AR/AP Deposit
-- Application yang di-reverse ikut menggeser outstanding/remaining invoice & deposit
-- terkait). Lebih gampang diaudit di 1 tempat daripada dicicil per modul.
-- ============================================================

create function journal_entries_sync_reversal_status() returns trigger as $$
declare
  v_id uuid;
begin
  if new.reverses_entry_id is null then
    return new;
  end if;

  for v_id in select id from ar_invoices where journal_entry_id = new.reverses_entry_id loop
    perform recompute_ar_invoice_status(v_id);
  end loop;

  for v_id in select id from ap_bills where journal_entry_id = new.reverses_entry_id loop
    perform recompute_ap_bill_status(v_id);
  end loop;

  update pos_sales set status = 'dibatalkan' where revenue_journal_entry_id = new.reverses_entry_id;

  for v_id in select invoice_id from ar_deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_ar_invoice_status(v_id);
  end loop;
  for v_id in select deposit_id from ar_deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_ar_deposit_status(v_id);
  end loop;

  for v_id in select bill_id from ap_deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_ap_bill_status(v_id);
  end loop;
  for v_id in select deposit_id from ap_deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_ap_deposit_status(v_id);
  end loop;

  -- Belum ada RPC yang bikin reversal ar_bad_debt_writeoffs sekarang (gak ada fitur
  -- recovery piutang, lihat memory/brief.md) -- cabang ini gak akan pernah kena, dijaga
  -- defensif biar konsisten kalau fitur itu dibangun nanti (ar_invoice_remaining sendiri
  -- udah defensif soal ini sejak awal).
  for v_id in select invoice_id from ar_bad_debt_writeoffs where journal_entry_id = new.reverses_entry_id loop
    perform recompute_ar_invoice_status(v_id);
  end loop;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger journal_entries_sync_reversal_status_trigger
  after insert on journal_entries
  for each row execute function journal_entries_sync_reversal_status();

-- ============================================================
-- Backfill data lama -- reuse fungsi recompute_* yang sama persis dipakai trigger,
-- bukan expresi terpisah, biar gak ada 2 sumber kebenaran yang bisa drift.
-- ============================================================

do $$
declare
  v_id uuid;
begin
  for v_id in select id from ar_invoices loop
    perform recompute_ar_invoice_status(v_id);
  end loop;

  for v_id in select id from ap_bills loop
    perform recompute_ap_bill_status(v_id);
  end loop;

  for v_id in select id from purchase_orders loop
    perform recompute_purchase_order_status(v_id);
  end loop;

  for v_id in select id from sales_orders loop
    perform recompute_sales_order_status(v_id);
  end loop;

  for v_id in select id from ap_deposits loop
    perform recompute_ap_deposit_status(v_id);
  end loop;

  for v_id in select id from ar_deposits loop
    perform recompute_ar_deposit_status(v_id);
  end loop;
end $$;

update pos_sales ps
  set total = coalesce((select sum(line_amount) from pos_sale_lines where pos_sale_id = ps.id), 0),
      status = case
        when exists (select 1 from journal_entries je where je.reverses_entry_id = ps.revenue_journal_entry_id)
        then 'dibatalkan' else 'normal'
      end;

-- ============================================================
-- Redefinisi ke-7 view jadi SELECT polos dari kolom asli -- gak ada lagi lateral
-- subquery. Nama, urutan, & tipe kolom dijaga PERSIS sama kayak sebelumnya (syarat
-- CREATE OR REPLACE VIEW), jadi ke-7 queries.ts (apps/erp/src/lib/*/queries.ts) TIDAK
-- perlu diubah sama sekali -- grant existing juga tetap berlaku.
-- ============================================================

create or replace view ar_invoices_with_status
  with (security_invoker = true) as
select
  id, customer_id, invoice_date, due_date, description, source_ref, amount,
  journal_entry_id, created_at, outstanding, returned, status, origin
from ar_invoices;

create or replace view ap_bills_with_status
  with (security_invoker = true) as
select
  id, supplier_id, bill_date, due_date, description, source_ref, supplier_document_ref,
  amount, journal_entry_id, created_at, outstanding, status, origin
from ap_bills;

create or replace view purchase_orders_with_status
  with (security_invoker = true) as
select
  id, supplier_id, po_date, expected_date, source_ref, created_at, cancelled_at, status
from purchase_orders;

create or replace view sales_orders_with_status
  with (security_invoker = true) as
select
  id, customer_id, so_date, expected_date, source_ref, created_at, cancelled_at, status
from sales_orders;

create or replace view pos_sales_with_status
  with (security_invoker = true) as
select
  id, customer_id, sale_date, cash_account_id, revenue_journal_entry_id, source_ref,
  created_at, total, status
from pos_sales;

create or replace view ap_deposits_with_status
  with (security_invoker = true) as
select
  id, supplier_id, deposit_date, source_ref, amount, journal_entry_id, created_at,
  remaining, status
from ap_deposits;

create or replace view ar_deposits_with_status
  with (security_invoker = true) as
select
  id, customer_id, deposit_date, source_ref, amount, journal_entry_id, created_at,
  remaining, status
from ar_deposits;
