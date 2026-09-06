-- Bergantung pada 0074 (transactions/payments/deposits.type sudah dibalik) sudah ter-apply.
--
-- 2 perubahan independen digabung 1 migration karena saling terkait erat:
-- (A) Rename credit_notes -> returns (+ kolom FK credit_note_id -> return_id di
--     return_credits/warranty_replacements) -- nama tabel lebih jelas, konteks pakainya
--     memang cuma buat retur. Konsekuensi trigger: credit_notes_type_matches_transaction
--     (fungsi TETAP nama lama, pola sama ar_invoice_remaining yang juga gak ikut di-rename
--     pas transactions unify) sekarang cek KEBALIKAN (bukan SAMA) terhadap transactions.type
--     -- retur adalah pembalikan arah dari transaksi induknya, nilai type di returns/
--     return_credits TIDAK PERNAH diubah baik migration ini maupun 0074.
-- (B) Hapus klasifikasi condition (RESALABLE/DAMAGED) dari alur retur AR -- barang rusak dari
--     retur dialihkan ke stock_opname generic (mirror pola AP, migration 0068). Sekalian merge
--     purchase_return_lines+inventory_return_lines jadi 1 tabel generic return_lines (opsi
--     FLATTEN -- tanpa header terpisah, goods_issue_id/jurnal ke-2 jadi kolom nullable
--     langsung di tiap baris, cuma keisi type='INBOUND'). Kolom condition TETAP ada di
--     return_lines (historical-only, default RESALABLE, RPC baru gak pernah isi DAMAGED) --
--     data historis DAMAGED gak boleh diubah/dihapus (invariant "no editing posted period").
--
-- RPC create_ar_credit_note/create_ap_credit_note (user-facing, jadi ikut di-rename)
-- -> create_ar_return/create_ap_return. Trigger/fungsi internal LAIN sengaja TETAP pakai nama
-- lama (return_credits_type_matches_credit_note, dst) -- cuma badan/target tabelnya yang
-- diperbaiki, konsisten pola ar_invoice_remaining yang juga gak ikut di-rename pas transactions
-- unify (0063-0067).

-- ============================================================
-- 1. Rename tabel + kolom FK. Trigger yang nempel di credit_notes OTOMATIS ikut ke returns
--    (ALTER TABLE RENAME gak minta drop/recreate trigger), begitu juga semua FK constraint
--    yang nunjuk credit_notes(id) otomatis ikut nunjuk returns(id).
-- ============================================================
alter table credit_notes rename to returns;
alter table return_credits rename column credit_note_id to return_id;
alter table warranty_replacements rename column credit_note_id to return_id;

alter policy credit_notes_select on returns rename to returns_select;
alter policy credit_notes_insert on returns rename to returns_insert;

-- ============================================================
-- 2. credit_notes_type_matches_transaction -- SATU-SATUNYA logic yang beneran berubah cara
--    bandingnya: dari "harus SAMA" jadi "harus KEBALIKAN" (transactions.type sudah dibalik
--    migration 0074, returns.type TIDAK ikut dibalik -- retur harus tetap kebalikan arah).
-- ============================================================
create or replace function credit_notes_type_matches_transaction() returns trigger as $$
declare
  v_transaction_type text;
begin
  select type into v_transaction_type from transactions where id = new.transaction_id;
  if v_transaction_type = new.type then
    raise exception 'returns.type (%) harus KEBALIKAN dari transactions.type (%) buat transaction_id % -- retur adalah pembalikan arah, bukan arah yang sama', new.type, v_transaction_type, new.transaction_id;
  end if;
  return new;
end;
$$ language plpgsql;

-- ============================================================
-- 3. credit_notes_no_over_return -- retarget FROM credit_notes -> FROM returns, logic TIDAK berubah.
-- ============================================================
create or replace function credit_notes_no_over_return() returns trigger as $$
declare
  v_transaction_amount numeric;
  v_already_returned numeric;
  v_transaction_ref text;
begin
  select amount into v_transaction_amount from transactions where id = new.transaction_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from returns where transaction_id = new.transaction_id;

  if v_already_returned + new.amount > v_transaction_amount then
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Retur % melebihi nilai transaksi (nilai %, sudah diretur %, coba retur %)',
      v_transaction_ref, v_transaction_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- credit_notes_sync_transaction_status: gak disentuh, body cuma pakai new.transaction_id,
-- gak pernah nyebut nama tabel credit_notes/returns sama sekali.

-- ============================================================
-- 4. return_credits & warranty_replacements: retarget referensi credit_notes -> returns,
--    credit_note_id -> return_id. Nama fungsi TETAP (lihat catatan di atas).
-- ============================================================
create or replace function return_credits_type_matches_credit_note() returns trigger as $$
declare
  v_return_type text;
begin
  select type into v_return_type from returns where id = new.return_id;
  if v_return_type is distinct from new.type then
    raise exception 'return_credits.type (%) gak cocok sama returns.type (%) buat return_id %', new.type, v_return_type, new.return_id;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function return_credits_sync_transaction_status() returns trigger as $$
declare
  v_transaction_id uuid;
begin
  select transaction_id into v_transaction_id from returns where id = new.return_id;
  if v_transaction_id is not null then
    perform recompute_transaction_status(v_transaction_id);
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((
        select sum(wr.return_credit_settled_amount)
        from warranty_replacements wr
        where wr.return_id = c.return_id
      ), 0)
    - coalesce((select sum(amount) from return_credit_refunds where credit_id = p_credit_id), 0)
  from return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

create or replace function return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_return_ref text;
begin
  select return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    select r.source_ref into v_return_ref
      from return_credits rc join returns r on r.id = rc.return_id
      where rc.id = new.credit_id;
    raise exception 'Refund saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba refund %)',
      v_return_ref, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function warranty_replacements_no_over_settle_return_credit() returns trigger as $$
declare
  v_credit_id uuid;
  v_remaining numeric;
  v_return_ref text;
begin
  if new.return_credit_settled_amount = 0 then
    return new;
  end if;

  select id into v_credit_id from return_credits where return_id = new.return_id;

  if v_credit_id is null then
    select source_ref into v_return_ref from returns where id = new.return_id;
    raise exception 'Retur % gak punya saldo kredit retur aktif — gak bisa isi return_credit_settled_amount', v_return_ref;
  end if;

  select return_credit_remaining(v_credit_id) into v_remaining;

  if new.return_credit_settled_amount > v_remaining then
    select r.source_ref into v_return_ref
      from return_credits rc join returns r on r.id = rc.return_id
      where rc.id = v_credit_id;
    raise exception 'Penyelesaian saldo kredit retur (dari %) melebihi sisa saldo (sisa %, coba selesaikan %)',
      v_return_ref, v_remaining, new.return_credit_settled_amount;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function warranty_replacements_no_over_reverse() returns trigger as $$
declare
  v_return_amount numeric;
  v_already_reversed numeric;
begin
  select amount into v_return_amount from returns where id = new.return_id;

  select coalesce(sum(discount_reversed_amount), 0) into v_already_reversed
    from warranty_replacements where return_id = new.return_id;

  if v_already_reversed + new.discount_reversed_amount > v_return_amount then
    raise exception 'Pembalikan diskon retur melebihi diskon yang diberikan (diskon %, sudah dibalik %, coba balik %)',
      v_return_amount, v_already_reversed, new.discount_reversed_amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- 5. Reducer transaksi (versi 0074) -- retarget credit_notes -> returns, literal
--    'INBOUND'/'OUTBOUND' TIDAK berubah lagi (udah final sejak 0074).
-- ============================================================
create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from payments where transaction_id = p_invoice_id and type = 'OUTBOUND'
      ), 0)
    - coalesce((
        select sum(amount) from returns where transaction_id = p_invoice_id and type = 'INBOUND'
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
        join returns r on r.id = rc.return_id
        where r.transaction_id = p_invoice_id
      ), 0)
    + coalesce((
        select sum(wr.discount_reversed_amount - wr.return_credit_settled_amount)
        from warranty_replacements wr
        join returns r on r.id = wr.return_id
        where r.transaction_id = p_invoice_id
      ), 0)
  from transactions ai
  where ai.id = p_invoice_id;
$$ language sql stable;

create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from payments where transaction_id = p_bill_id and type = 'INBOUND'), 0)
    - coalesce((select sum(amount) from returns where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id
          )
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join returns r on r.id = rc.return_id
        where r.transaction_id = p_bill_id
      ), 0)
  from transactions ab
  where ab.id = p_bill_id;
$$ language sql stable;

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
  v_return_count int;
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

  select count(*) into v_return_count
  from returns where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_return_count > 0 then
    select source_ref into v_bill_ref from transactions where id = p_bill_id;
    raise exception 'Bill % udah punya % retur -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_return_count;
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
      from returns where transaction_id = p_transaction_id and type = 'INBOUND';

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

-- ============================================================
-- 6. Tabel baru return_lines (flatten) -- gantiin inventory_returns+inventory_return_lines+
--    purchase_return_lines. condition historical-only (default RESALABLE, RPC baru gak pernah
--    isi DAMAGED). goods_issue_id/hpp_reversal_journal_entry_id nullable, cuma keisi
--    type='INBOUND' (AR butuh snapshot cost + jurnal ke-2, AP enggak).
-- ============================================================
create table return_lines (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  return_id uuid not null references returns(id),
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0),
  condition text not null default 'RESALABLE' check (condition in ('RESALABLE', 'DAMAGED')),
  goods_issue_id uuid references goods_issues(id),
  hpp_reversal_journal_entry_id uuid references journal_entries(id)
);

create unique index return_lines_id_item_id_key on return_lines(id, item_id);
create index return_lines_return_id_idx on return_lines(return_id);

-- Backfill: pertahankan id asli (0 dampak referensi historis, konsisten pola migration lain).
insert into return_lines (id, type, return_id, item_id, qty_returned, total_cost, condition, goods_issue_id, hpp_reversal_journal_entry_id)
select irl.id, 'INBOUND', ir.credit_note_id, irl.item_id, irl.qty_returned, irl.total_cost, irl.condition, ir.goods_issue_id, ir.journal_entry_id
from inventory_return_lines irl
join inventory_returns ir on ir.id = irl.inventory_return_id;

insert into return_lines (id, type, return_id, item_id, qty_returned, total_cost, condition, goods_issue_id, hpp_reversal_journal_entry_id)
select prl.id, 'OUTBOUND', prl.credit_note_id, prl.item_id, prl.qty_returned, prl.total_cost, 'RESALABLE', null, null
from purchase_return_lines prl;

create trigger return_lines_block_edit_delete
  before update or delete on return_lines
  for each row execute function block_edit_delete();

-- No-over-return AR: goods_issue_id sekarang langsung di baris (gak perlu 2-hop lewat header lagi).
create function return_lines_no_over_return_inbound() returns trigger as $$
declare
  v_invoice_id uuid;
  v_qty_issued numeric;
  v_already_claimed numeric;
begin
  select gi.invoice_id into v_invoice_id
    from goods_issues gi where gi.id = new.goods_issue_id;

  select gil.qty_issued into v_qty_issued
    from goods_issue_lines gil
    where gil.goods_issue_id = new.goods_issue_id and gil.item_id = new.item_id;

  if not found then
    raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', new.item_id, new.goods_issue_id;
  end if;

  select sales_returned_qty(v_invoice_id, new.item_id) into v_already_claimed;

  if v_already_claimed + new.qty_returned > v_qty_issued then
    raise exception 'Retur item % melebihi qty terjual dikurangi yang udah diklaim lewat retur/ganti barang (terjual %, udah diklaim %, coba retur %)',
      new.item_id, v_qty_issued, v_already_claimed, new.qty_returned;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger return_lines_no_over_return_inbound_trigger
  before insert on return_lines
  for each row when (new.type = 'INBOUND')
  execute function return_lines_no_over_return_inbound();

-- No-over-return AP: lookup bill_id lewat returns.transaction_id (return_lines gak punya
-- transaction_id langsung -- beda dari sisi INBOUND yang punya goods_issue_id sendiri).
create function return_lines_no_over_return_outbound() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
  v_bill_ref text;
  v_item_name text;
begin
  select transaction_id into v_bill_id from returns where id = new.return_id;
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

create trigger return_lines_no_over_return_outbound_trigger
  before insert on return_lines
  for each row when (new.type = 'OUTBOUND')
  execute function return_lines_no_over_return_outbound();

alter table return_lines enable row level security;

create policy return_lines_select on return_lines
  for select using (auth.role() = 'authenticated');

create policy return_lines_insert on return_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on return_lines to authenticated;

-- ============================================================
-- 7. sales_returned_qty/purchase_returned_qty -- retarget ke return_lines (1 hop, dulu 2 hop
--    buat sisi AR lewat inventory_returns).
-- ============================================================
create or replace function sales_returned_qty(p_invoice_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(rl.qty_returned) from return_lines rl
      join returns r on r.id = rl.return_id
      where r.transaction_id = p_invoice_id and rl.type = 'INBOUND' and rl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(wrl.qty_replaced) from warranty_replacement_lines wrl
      join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
      where wr.invoice_id = p_invoice_id and wrl.item_id = p_item_id
    ), 0);
$$ language sql stable;

create or replace function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(rl.qty_returned) from return_lines rl
      join returns r on r.id = rl.return_id
      where r.transaction_id = p_bill_id and rl.type = 'OUTBOUND' and rl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(prpl.qty_replaced) from purchase_replacement_lines prpl
      join purchase_replacements prp on prp.id = prpl.purchase_replacement_id
      where prp.bill_id = p_bill_id and prpl.item_id = p_item_id
    ), 0);
$$ language sql stable;

-- ============================================================
-- 8. create_ar_return/create_ap_return -- gantiin create_ar_credit_note/create_ap_credit_note.
--    Param condition/p_loss_expense_account_id DIHAPUS -- semua baris retur selalu restock.
-- ============================================================
create function create_ar_return(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null,
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_return_id uuid;
  v_goods_issue_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_qty_issued numeric;
  v_total_cost numeric;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_total_cost_returned numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_hpp_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
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

  insert into returns (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('INBOUND', p_invoice_id, p_credit_note_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_return_id;

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

    insert into return_credits (type, counterparty_id, return_id, amount, journal_entry_id, created_by)
    values ('INBOUND', v_customer_id, v_return_id, v_excess, v_return_credit_entry_id, auth.uid());
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

      select qty_on_hand, avg_cost into v_qty_before, v_avg_before
        from inventory_balances where item_id = v_item_id;

      update inventory_balances
        set qty_on_hand = v_qty_before + v_qty_returned,
            avg_cost = (v_qty_before * v_avg_before + v_qty_returned * v_unit_cost) / (v_qty_before + v_qty_returned),
            updated_at = now()
        where item_id = v_item_id;

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

    for i in 1..array_length(v_line_items, 1) loop
      insert into return_lines (type, return_id, item_id, qty_returned, total_cost, goods_issue_id, hpp_reversal_journal_entry_id)
      values ('INBOUND', v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_goods_issue_id, v_hpp_entry_id)
      returning id into v_line_id;

      insert into inventory_movements (item_id, movement_date, qty, return_line_id)
      values (v_line_items[i], p_credit_note_date, v_line_qtys[i], v_line_id);
    end loop;
  end if;

  return v_return_id;
end;
$$;

create function create_ap_return(
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
  v_return_id uuid;
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

  insert into returns (type, transaction_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values ('OUTBOUND', p_bill_id, p_credit_note_date, p_source_ref, v_effective_amount, v_entry_id, auth.uid())
  returning id into v_return_id;

  if array_length(v_line_items, 1) is not null then
    for i in 1..array_length(v_line_items, 1) loop
      insert into return_lines (type, return_id, item_id, qty_returned, total_cost)
      values ('OUTBOUND', v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
      returning id into v_line_id;

      insert into inventory_movements (item_id, movement_date, qty, return_line_id)
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

    insert into return_credits (type, counterparty_id, return_id, amount, journal_entry_id, created_by)
    values ('OUTBOUND', v_supplier_id, v_return_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  return v_return_id;
end;
$$;

drop function if exists create_ar_credit_note(uuid, date, text, numeric, uuid, uuid, jsonb, uuid, uuid, uuid, uuid);
drop function if exists create_ap_credit_note(uuid, date, text, numeric, uuid, uuid, jsonb, uuid);

-- ============================================================
-- 9. inventory_movements -- gabung 2 kolom polymorphic jadi 1 (return_line_id).
-- ============================================================
alter table inventory_movements add column return_line_id uuid;

-- inventory_movements immutable (block_edit_delete, 0042) -- backfill butuh UPDATE, lepas
-- sementara persis pola migration 0074 buat transactions/payments/deposits.
drop trigger inventory_movements_block_edit_delete on inventory_movements;

update inventory_movements
  set return_line_id = coalesce(inventory_return_line_id, purchase_return_line_id)
  where inventory_return_line_id is not null or purchase_return_line_id is not null;

create trigger inventory_movements_block_edit_delete
  before update or delete on inventory_movements
  for each row execute function block_edit_delete();

alter table inventory_movements
  add constraint inventory_movements_return_line_id_item_id_fkey
  foreign key (return_line_id, item_id) references return_lines(id, item_id);

-- ============================================================
-- 10. View inventory_movements_with_source -- retarget ke return_lines/returns (1 kolom
--     gabungan, dibedakan lewat rl.type, bukan 2 kolom polymorphic terpisah lagi). WAJIB
--     sebelum drop kolom lama di bawah -- view ini punya dependency BENERAN ke kolom
--     inventory_return_line_id/purchase_return_line_id (view, bukan fungsi plpgsql, jadi
--     Postgres nolak drop kolom kalau view lama masih nunjuk situ).
-- ============================================================
create or replace view inventory_movements_with_source as
select
  im.id,
  im.item_id,
  im.movement_date,
  im.qty,
  im.created_at,
  coalesce(
    case when im.goods_receipt_line_id is not null then 'Pembelian (Terima Barang)' else null end,
    case when im.production_order_id is not null then 'Produksi (Hasil)' else null end,
    case when im.return_line_id is not null and rl.type = 'INBOUND' then 'Retur dari Customer' else null end,
    case when im.stock_opname_line_id is not null then 'Penyesuaian Stock Opname' else null end,
    case when im.goods_issue_line_id is not null then 'Penjualan (Kirim Barang)' else null end,
    case when im.pos_sale_line_id is not null then 'Penjualan (Kios/POS)' else null end,
    case when im.production_order_line_id is not null then 'Produksi (Konsumsi Bahan)' else null end,
    case when im.return_line_id is not null and rl.type = 'OUTBOUND' then 'Retur ke Supplier' else null end,
    case when im.warranty_replacement_line_id is not null then 'Penggantian Garansi' else null end,
    case when im.purchase_replacement_line_id is not null then 'Tukar Barang (Retur Supplier)' else null end
  ) as source_label,
  coalesce(ap_bill.source_ref, prod_header.source_ref, r.source_ref, so.source_ref, gi.source_ref, ps.source_ref, prod_line_header.source_ref, wr.source_ref, pr.source_ref) as source_ref
from inventory_movements im
  left join goods_receipt_lines grl on grl.id = im.goods_receipt_line_id
  left join goods_receipt_notes grn on grn.id = grl.grn_id
  left join transactions ap_bill on ap_bill.id = grn.bill_id
  left join production_orders prod_header on prod_header.id = im.production_order_id
  left join return_lines rl on rl.id = im.return_line_id
  left join returns r on r.id = rl.return_id
  left join stock_opname_lines sol on sol.id = im.stock_opname_line_id
  left join stock_opnames so on so.id = sol.stock_opname_id
  left join goods_issue_lines gil on gil.id = im.goods_issue_line_id
  left join goods_issues gi on gi.id = gil.goods_issue_id
  left join pos_sale_lines psl on psl.id = im.pos_sale_line_id
  left join pos_sales ps on ps.id = psl.pos_sale_id
  left join production_order_lines pol on pol.id = im.production_order_line_id
  left join production_orders prod_line_header on prod_line_header.id = pol.production_order_id
  left join warranty_replacement_lines wrl on wrl.id = im.warranty_replacement_line_id
  left join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
  left join purchase_replacement_lines prpl on prpl.id = im.purchase_replacement_line_id
  left join purchase_replacements pr on pr.id = prpl.purchase_replacement_id;

-- Drop kolom lama -- otomatis nyabut FK constraint lama yang nempel di kolom itu. Aman sekarang,
-- view di atas udah gak nunjuk ke sini lagi.
alter table inventory_movements drop column inventory_return_line_id;
alter table inventory_movements drop column purchase_return_line_id;

-- Catatan: constraint num_nonnulls lama (0042/0046) udah HILANG diam-diam sejak migration 0068
-- (drop column purchase_writeoff_line_id nyabut constraint yang nunjuk kolom itu, gak pernah
-- ditambahin balik) -- SENGAJA TIDAK dipulihkan di migration ini. Ketauan pas nyoba restore:
-- ada 2 baris live (item sama, created_at identik, TANPA journal_entries terkait -- indikasi
-- insert manual di luar RPC) yang num_nonnulls-nya 0, bukan 1 -- pemulihan constraint butuh
-- keputusan bisnis dulu soal 2 baris itu (dikaitkan ke stock_opname retroaktif / dihapus /
-- dibiarkan), di luar scope migration ini. Dicatat scope-debt terpisah.

-- ============================================================
-- 11. Drop tabel lama (anak dulu, baru header) + fungsi guard yang jadi orphan.
-- ============================================================
drop table if exists inventory_return_lines;
drop table if exists purchase_return_lines;
drop table if exists inventory_returns;

drop function if exists inventory_return_lines_guard();
drop function if exists purchase_return_lines_no_over_return();
