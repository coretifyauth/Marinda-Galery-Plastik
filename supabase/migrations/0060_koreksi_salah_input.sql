-- 0060_koreksi_salah_input.sql
-- Jalan keluar untuk salah input setelah transaksi kesentuh pembayaran/stok. Konsep bisnis:
-- docs/domain/accounts-payable.md submodule "Koreksi Salah Input", docs/domain/inventory.md "Koreksi Barang Masuk".
-- Struktur data: docs/architecture/payments-schema.md, transactions-schema.md, goods-notes-schema.md.
--
-- Isi:
--   1. Batalkan Pembayaran (AP & AR): payment_cancellations + cancel_payment. Semua hitungan sisa tagihan membaca
--      pembayaran AKTIF saja.
--   2. Koreksi Tagihan (nota kredit/debit supplier, hanya tagihan barang): ap_bill_adjustments + adjust_ap_bill.
--      Menaikkan/menurunkan utang dan sisa barang belum diterima sekaligus.
--   3. Koreksi Barang Masuk: goods_receipt_revisions + revise_goods_receipt. Dokumen lama dibatalkan dan dokumen baru
--      dibuat dalam satu transaksi; selisih nilai atas barang yang sudah terjual masuk HPP periode berjalan.
--   4. Batalkan Tagihan satu tombol: ap_bill_cancellation_preview + cancel_ap_bill_cascade.
--   5. cancel_ap_bill membalik penerapan uang muka dan koreksi tagihan (mirror cancel_ar_invoice).
--   6. create_ap_return menolak akun kredit yang merusak buku besar.

-- Supabase CLI menjalankan tiap statement TERPISAH (bukan satu transaksi per file) -- transaksi harus eksplisit supaya gagal di tengah = batal semua.
begin;

insert into document_number_types (doc_type, prefix, label) values
  ('ap_bill_adjustments', 'APA', 'Koreksi Tagihan AP')
on conflict (doc_type) do nothing;

-- ============================================================================================
-- 1. Tabel pendamping (append-only, baris induknya immutable)
-- ============================================================================================

create table payment_cancellations (
  payment_id uuid primary key references payments(id),
  journal_entry_id uuid not null references journal_entries(id),
  reason text not null check (length(trim(reason)) > 0),
  money_moved boolean not null, -- uangnya benar-benar berpindah: pembayaran harus dicatat ulang supaya kas/bank cocok
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz not null default now()
);

create trigger payment_cancellations_block_edit_delete
  before update or delete on payment_cancellations
  for each row execute function block_edit_delete();

alter table payment_cancellations enable row level security;

create policy payment_cancellations_select on payment_cancellations
  for select using (auth.role() = 'authenticated');

create policy payment_cancellations_insert on payment_cancellations
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on payment_cancellations to authenticated;

create table ap_bill_adjustments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  amount numeric(14,2) not null check (amount <> 0), -- + = tagihan naik (nota debit), - = tagihan turun (nota kredit)
  adjustment_date date not null,
  source_ref text not null,
  supplier_document_ref text,
  reason text not null check (length(trim(reason)) > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_bill_adjustments_transaction_id_idx on ap_bill_adjustments(transaction_id);

create trigger ap_bill_adjustments_block_edit_delete
  before update or delete on ap_bill_adjustments
  for each row execute function block_edit_delete();

alter table ap_bill_adjustments enable row level security;

create policy ap_bill_adjustments_select on ap_bill_adjustments
  for select using (auth.role() = 'authenticated');

create policy ap_bill_adjustments_insert on ap_bill_adjustments
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on ap_bill_adjustments to authenticated;

create table ap_bill_cancellations (
  transaction_id uuid primary key references transactions(id),
  reason text not null check (length(trim(reason)) > 0),
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz not null default now()
);

create trigger ap_bill_cancellations_block_edit_delete
  before update or delete on ap_bill_cancellations
  for each row execute function block_edit_delete();

alter table ap_bill_cancellations enable row level security;

create policy ap_bill_cancellations_select on ap_bill_cancellations
  for select using (auth.role() = 'authenticated');

create policy ap_bill_cancellations_insert on ap_bill_cancellations
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on ap_bill_cancellations to authenticated;

create table goods_receipt_revisions (
  old_goods_note_id uuid primary key references goods_notes(id),
  new_goods_note_id uuid not null unique references goods_notes(id),
  reason text not null check (length(trim(reason)) > 0),
  cogs_adjustment numeric(14,2) not null default 0, -- + = HPP naik, - = HPP turun
  cogs_journal_entry_id uuid references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check ((cogs_adjustment = 0) = (cogs_journal_entry_id is null))
);

create trigger goods_receipt_revisions_block_edit_delete
  before update or delete on goods_receipt_revisions
  for each row execute function block_edit_delete();

alter table goods_receipt_revisions enable row level security;

create policy goods_receipt_revisions_select on goods_receipt_revisions
  for select using (auth.role() = 'authenticated');

create policy goods_receipt_revisions_insert on goods_receipt_revisions
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on goods_receipt_revisions to authenticated;

-- ============================================================================================
-- 2. Hitungan sisa tagihan: pembayaran aktif + koreksi tagihan
-- ============================================================================================

create function transaction_active_payments(p_transaction_id uuid, p_type text) returns numeric
language sql stable
as $$
  select coalesce(sum(p.amount), 0)
  from payments p
  where p.transaction_id = p_transaction_id and p.type = p_type
    and not exists (select 1 from payment_cancellations c where c.payment_id = p.id)
$$;

create function ap_bill_adjustments_total(p_bill_id uuid) returns numeric
language sql stable
as $$
  select coalesce(sum(amount), 0) from ap_bill_adjustments where transaction_id = p_bill_id
$$;

create or replace function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
declare
  v_result numeric;
begin
  select ai.amount
    - transaction_active_payments(p_invoice_id, 'OUTBOUND')
    - coalesce((select sum(amount) from returns where transaction_id = p_invoice_id and type = 'INBOUND'), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_invoice_id
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join returns r on r.id = rc.return_id
        where r.transaction_id = p_invoice_id
      ), 0)
  into v_result
  from transactions ai
  where ai.id = p_invoice_id;
  return v_result;
end;
$$ language plpgsql stable;

create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
declare
  v_result numeric;
begin
  select ab.amount
    + ap_bill_adjustments_total(p_bill_id)
    - transaction_active_payments(p_bill_id, 'INBOUND')
    - coalesce((select sum(amount) from returns where transaction_id = p_bill_id and type = 'OUTBOUND'), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_bill_id
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join returns r on r.id = rc.return_id
        where r.transaction_id = p_bill_id
      ), 0)
  into v_result
  from transactions ab
  where ab.id = p_bill_id;
  return v_result;
end;
$$ language plpgsql stable;

create or replace function ap_bill_pool_paid(p_bill_id uuid) returns numeric
language sql stable
as $$
  select transaction_active_payments(p_bill_id, 'INBOUND')
       + coalesce((
           select sum(da.amount) from deposit_applications da
           where da.transaction_id = p_bill_id
             and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
         ), 0)
$$;

-- Sisa kolam = kolam awal + koreksi tagihan - nilai barang masuk aktif - pelepasan. NULL kalau bukan tagihan barang.
create or replace function ap_bill_pool_remaining(p_bill_id uuid) returns numeric
language sql stable
as $$
  select p.amount + ap_bill_adjustments_total(p.transaction_id)
         - ap_bill_pool_received_value(p.transaction_id) - ap_bill_pool_released(p.transaction_id)
  from ap_bill_goods_pools p
  where p.transaction_id = p_bill_id
$$;

-- pool_amount sekarang kolam SETELAH koreksi; adjustment_amount (kolom baru di ujung) = jumlah koreksinya.
create or replace view ap_bill_goods_pool_status
  with (security_invoker = true) as
select
  p.transaction_id as bill_id,
  t.counterparty_id,
  cp.name as supplier_name,
  t.source_ref as bill_ref,
  t.date as bill_date,
  t.status as bill_status,
  (p.amount + v.adjustment_amount)::numeric(14,2) as pool_amount,
  v.received_value,
  v.released_amount,
  p.amount + v.adjustment_amount - v.received_value - v.released_amount as remaining,
  case when t.status <> 'dibatalkan' and p.amount + v.adjustment_amount - v.received_value - v.released_amount > 0
       then current_date - t.date else null end as open_age_days,
  v.adjustment_amount
from ap_bill_goods_pools p
join transactions t on t.id = p.transaction_id
left join counterparties cp on cp.id = t.counterparty_id
cross join lateral (
  select ap_bill_pool_received_value(p.transaction_id) as received_value,
         ap_bill_pool_released(p.transaction_id) as released_amount,
         ap_bill_adjustments_total(p.transaction_id) as adjustment_amount
) v;

-- recompute_transaction_status -- sama persis 0058 kecuali v_allocated hanya pembayaran aktif.
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

    v_allocated := transaction_active_payments(p_transaction_id, 'OUTBOUND');

    select coalesce(sum(amount), 0) into v_deposit_applied
      from deposit_applications where transaction_id = p_transaction_id;

    v_status := case
      when v_is_cancelled then 'dibatalkan'
      when v_outstanding <= 0.005 then 'lunas'
      when v_allocated > 0 or v_deposit_applied > 0 then 'sebagian'
      else 'belum'
    end;

    v_origin := case
      when not exists (select 1 from goods_notes gn where gn.transaction_id = p_transaction_id and gn.type = 'OUTBOUND') then 'financial_only'
      when exists (
        select 1 from goods_notes gn
        join goods_note_lines gnl on gnl.goods_note_id = gn.id
        where gn.transaction_id = p_transaction_id and gn.type = 'OUTBOUND' and gnl.order_line_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, returned = v_returned, status = v_status, origin = v_origin
      where id = p_transaction_id;
  else
    v_outstanding := ap_bill_remaining(p_transaction_id);

    v_allocated := transaction_active_payments(p_transaction_id, 'INBOUND');

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
      when not exists (
        select 1 from goods_notes gn
        where gn.transaction_id = p_transaction_id and gn.type = 'INBOUND'
          and (gn.journal_entry_id is null or goods_note_is_active(gn.id))
      ) then 'financial_only'
      when exists (
        select 1 from goods_notes gn
        where gn.transaction_id = p_transaction_id and gn.type = 'INBOUND'
          and (gn.journal_entry_id is null or goods_note_is_active(gn.id))
          and gn.order_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, status = v_status, origin = v_origin
      where id = p_transaction_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

-- pos_sales_with_status -- sama persis 0054 kecuali penjualan yang pembayarannya dibatalkan bukan penjualan kios lagi
-- (sudah jadi invoice biasa yang belum dibayar).
create or replace view pos_sales_with_status
  with (security_invoker = true) as
select
  t.id, t.date as sale_date, t.source_ref, t.journal_entry_id as revenue_journal_entry_id,
  t.amount as total,
  case when t.status = 'lunas' then 'normal' else t.status end as status,
  t.counterparty_id as customer_id, c.name as customer_name,
  cash_jl.account_id as cash_account_id, ca.code as cash_account_code, ca.name as cash_account_name,
  pay.payment_method, pay.cash_tendered, pay.change_given, pay.rounding_amount
from transactions t
  join goods_notes gi on gi.transaction_id = t.id and gi.type = 'OUTBOUND'
  join payments pay on pay.transaction_id = t.id and pay.type = 'OUTBOUND' and pay.amount = t.amount
  left join lateral (
    select jl.account_id
    from journal_lines jl
    join accounts a on a.id = jl.account_id
    where jl.journal_entry_id = pay.journal_entry_id
      and jl.debit > 0
      and a.category = 'asset'
    order by jl.debit desc, jl.account_id
    limit 1
  ) cash_jl on true
  left join counterparties c on c.id = t.counterparty_id
  left join accounts ca on ca.id = cash_jl.account_id
where t.type = 'OUTBOUND'
  and not exists (
    select 1 from goods_notes gi2 where gi2.transaction_id = t.id and gi2.type = 'OUTBOUND' and gi2.id <> gi.id
  )
  and not exists (select 1 from payments p2 where p2.transaction_id = t.id and p2.type = 'OUTBOUND' and p2.id <> pay.id)
  and not exists (select 1 from returns r where r.transaction_id = t.id)
  and not exists (select 1 from deposit_applications da where da.transaction_id = t.id)
  and not exists (select 1 from payment_cancellations pc where pc.payment_id = pay.id);

-- ============================================================================================
-- 3. Batalkan Pembayaran
-- ============================================================================================

-- cancel_payment -- membalik jurnal pembayaran (termasuk baris selisih pembulatan). Artinya "catatannya salah", bukan
-- "uangnya kembali": kalau uangnya benar-benar berpindah (p_money_moved), pembayaran wajib dicatat ulang.
-- Ditolak kalau kelebihan retur sudah jadi saldo (saldo itu dihitung dengan asumsi tagihan sudah dibayar), atau uang
-- yang dibatalkan sudah dilepas jadi uang muka dari sisa barang.
create function cancel_payment(
  p_payment_id uuid,
  p_entry_date date,
  p_reason text,
  p_money_moved boolean
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_payment payments%rowtype;
  v_bill transactions%rowtype;
  v_pool_amount numeric;
  v_reversal_id uuid;
begin
  select * into v_payment from payments where id = p_payment_id;
  if not found then
    raise exception 'Pembayaran % gak ditemukan', p_payment_id;
  end if;

  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || v_payment.transaction_id::text));
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || v_payment.transaction_id::text));

  if exists (select 1 from payment_cancellations c where c.payment_id = p_payment_id) then
    raise exception 'Pembayaran % sudah dibatalkan', v_payment.source_ref;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Alasan pembatalan pembayaran wajib diisi';
  end if;
  if p_money_moved is null then
    raise exception 'Wajib dijawab: apakah uangnya benar-benar berpindah';
  end if;

  select * into v_bill from transactions where id = v_payment.transaction_id;
  if v_bill.status = 'dibatalkan' then
    raise exception 'Transaksi % sudah dibatalkan', v_bill.source_ref;
  end if;

  if p_entry_date < v_payment.payment_date then
    raise exception 'Tanggal pembatalan % lebih awal dari tanggal pembayaran %', p_entry_date, v_payment.payment_date;
  end if;
  perform assert_period_open(p_entry_date);

  if exists (
    select 1 from return_credits rc join returns r on r.id = rc.return_id
    where r.transaction_id = v_payment.transaction_id
  ) then
    raise exception 'Pembayaran % gak bisa dibatalkan: kelebihan retur di % sudah jadi saldo -- saldo itu dihitung dengan asumsi tagihan sudah dibayar',
      v_payment.source_ref, v_bill.source_ref;
  end if;

  if v_payment.type = 'INBOUND' then
    select amount into v_pool_amount from ap_bill_goods_pools where transaction_id = v_payment.transaction_id;
    if found and ap_bill_pool_released(v_payment.transaction_id, 'uang_muka') > 0
       and ap_bill_pool_paid(v_payment.transaction_id) - v_payment.amount
           - (v_bill.amount - v_pool_amount)
           - ap_bill_pool_received_value(v_payment.transaction_id)
           - ap_bill_pool_released(v_payment.transaction_id, 'uang_muka') < 0 then
      raise exception 'Pembayaran % gak bisa dibatalkan: uangnya sudah dilepas jadi uang muka dari sisa barang tagihan %',
        v_payment.source_ref, v_bill.source_ref;
    end if;
  end if;

  v_reversal_id := reverse_journal_entry(v_payment.journal_entry_id, p_entry_date, v_payment.source_ref || '/BTL');

  insert into payment_cancellations (payment_id, journal_entry_id, reason, money_moved, cancelled_by)
  values (p_payment_id, v_reversal_id, trim(p_reason), p_money_moved, auth.uid());

  perform recompute_transaction_status(v_payment.transaction_id);

  return v_reversal_id;
end;
$$;

grant execute on function cancel_payment(uuid, date, text, boolean) to authenticated;

-- void_pos_transaction -- sama persis 0056 kecuali menolak penjualan yang pembayarannya sudah dibatalkan (jurnalnya
-- sudah dibalik, membalik lagi bikin kas dobel) dan memakai lock yang sama dengan cancel_payment.
create or replace function void_pos_transaction(
  p_transaction_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_transaction_amount numeric;
  v_transaction_journal_entry_id uuid;
  v_goods_issue_id uuid;
  v_goods_issue_journal_entry_id uuid;
  v_payment_journal_entry_id uuid;
  v_payment_amount numeric;
  v_goods_issue_count int;
  v_payment_count int;
  v_return_count int;
  v_deposit_count int;
  v_already_voided boolean;
  v_new_entry_id uuid;
  v_line record;
begin
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || p_transaction_id::text));

  select amount, journal_entry_id into v_transaction_amount, v_transaction_journal_entry_id
    from transactions where id = p_transaction_id and type = 'OUTBOUND';
  if not found then
    raise exception 'Transaksi % bukan penjualan (OUTBOUND)', p_transaction_id;
  end if;

  select count(*) into v_goods_issue_count from goods_notes where transaction_id = p_transaction_id and type = 'OUTBOUND';
  select count(*) into v_payment_count from payments where transaction_id = p_transaction_id and type = 'OUTBOUND';
  select count(*) into v_return_count from returns where transaction_id = p_transaction_id;
  select count(*) into v_deposit_count from deposit_applications where transaction_id = p_transaction_id;

  if v_goods_issue_count != 1 or v_payment_count != 1 or v_return_count > 0 or v_deposit_count > 0 then
    raise exception
      'Transaksi % bukan pola penjualan kios sederhana (wajib persis 1 goods issue + 1 payment lunas penuh, tanpa retur/DP) -- pakai cancel_ar_invoice',
      p_transaction_id;
  end if;

  if exists (
    select 1 from payments p join payment_cancellations c on c.payment_id = p.id
    where p.transaction_id = p_transaction_id and p.type = 'OUTBOUND'
  ) then
    raise exception 'Transaksi % pembayarannya sudah dibatalkan -- pakai cancel_ar_invoice', p_transaction_id;
  end if;

  select id, journal_entry_id into v_goods_issue_id, v_goods_issue_journal_entry_id
    from goods_notes where transaction_id = p_transaction_id and type = 'OUTBOUND';

  select journal_entry_id, amount into v_payment_journal_entry_id, v_payment_amount
    from payments where transaction_id = p_transaction_id and type = 'OUTBOUND';

  if v_payment_amount != v_transaction_amount then
    raise exception
      'Transaksi % -- payment gak melunasi penuh (bayar %, total %) -- pakai cancel_ar_invoice',
      p_transaction_id, v_payment_amount, v_transaction_amount;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_transaction_journal_entry_id
  ) into v_already_voided;

  if v_already_voided then
    raise exception 'Transaksi % udah pernah dibatalkan', p_transaction_id;
  end if;

  perform reverse_journal_entry(v_payment_journal_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_goods_issue_journal_entry_id, p_entry_date, p_source_ref);
  v_new_entry_id := reverse_journal_entry(v_transaction_journal_entry_id, p_entry_date, p_source_ref);

  for v_line in select id, item_id, qty from goods_note_lines where goods_note_id = v_goods_issue_id loop
    perform inventory_restore_stock(v_line.item_id, v_line.qty);

    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line.item_id, p_entry_date, v_line.qty, v_line.id);
  end loop;

  return v_new_entry_id;
end;
$$;

-- cancel_ar_invoice -- sama persis 0056 kecuali guard pembayaran hanya menghitung pembayaran aktif.
create or replace function cancel_ar_invoice(
  p_invoice_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_paid_count int; v_return_count int; v_replacement_count int;
  v_original_entry_id uuid; v_new_entry_id uuid;
  v_application record; v_invoice_ref text; v_note record; v_line record;
begin
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || p_invoice_id::text));
  select source_ref, journal_entry_id into v_invoice_ref, v_original_entry_id
    from transactions where id = p_invoice_id and type = 'OUTBOUND';
  if not found then
    raise exception 'Invoice % gak ditemukan', p_invoice_id;
  end if;

  select count(*) into v_paid_count
  from payments p
  where p.transaction_id = p_invoice_id and p.type = 'OUTBOUND'
    and not exists (select 1 from payment_cancellations c where c.payment_id = p.id);

  if v_paid_count > 0 then
    raise exception 'Invoice % masih punya % pembayaran aktif -- batalkan pembayarannya dulu', v_invoice_ref, v_paid_count;
  end if;

  select count(*) into v_return_count
  from returns where transaction_id = p_invoice_id and type = 'INBOUND';

  if v_return_count > 0 then
    raise exception 'Invoice % udah punya % retur -- gak bisa dibatalkan lewat jalur ini', v_invoice_ref, v_return_count;
  end if;

  if exists (select 1 from goods_notes where transaction_id = p_invoice_id and type = 'OUTBOUND') then
    select count(*) into v_replacement_count from replacements where transaction_id = p_invoice_id;
    if v_replacement_count > 0 then
      raise exception 'Invoice % (barang keluar) udah punya penggantian barang -- urus itu dulu sebelum dibatalkan', v_invoice_ref;
    end if;

    if exists (select 1 from journal_entries je where je.reverses_entry_id = v_original_entry_id) then
      raise exception 'Invoice % udah pernah dibatalkan', v_invoice_ref;
    end if;

    for v_note in
      select id, journal_entry_id, order_id from goods_notes
      where transaction_id = p_invoice_id and type = 'OUTBOUND'
    loop
      perform reverse_journal_entry(v_note.journal_entry_id, p_entry_date, p_source_ref);

      for v_line in select id, item_id, qty from goods_note_lines where goods_note_id = v_note.id
      loop
        perform inventory_restore_stock(v_line.item_id, v_line.qty);

        insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
        values (v_line.item_id, p_entry_date, v_line.qty, v_line.id);
      end loop;
    end loop;
  end if;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select da.journal_entry_id from deposit_applications da
    where da.transaction_id = p_invoice_id
      and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  -- status transaksi sudah 'dibatalkan' (trigger journal_entries) -> qty SO kebebas.
  for v_note in
    select distinct order_id from goods_notes
    where transaction_id = p_invoice_id and type = 'OUTBOUND' and order_id is not null
  loop
    perform recompute_order_status(v_note.order_id);
  end loop;

  return v_new_entry_id;
end;
$$;

-- ============================================================================================
-- 4. Pembatalan barang masuk & tagihan
-- ============================================================================================

-- cancel_goods_receipt -- sama persis 0058 kecuali pesan penolakan mengarah ke Koreksi Barang Masuk (bukan retur/opname,
-- yang mencatat kejadian yang tidak pernah terjadi).
create or replace function cancel_goods_receipt(p_goods_note_id uuid, p_entry_date date) returns uuid
language plpgsql
security invoker
as $$
declare
  v_note goods_notes%rowtype;
  v_reversal_id uuid;
  v_item record;
  v_line record;
  v_qty_on_hand numeric;
  v_avg_cost numeric;
  v_pool numeric;
  v_new_pool numeric;
  v_new_value numeric;
  v_item_name text;
begin
  perform pg_advisory_xact_lock(hashtext('goods_receipt:' || p_goods_note_id::text));

  select * into v_note from goods_notes where id = p_goods_note_id and type = 'INBOUND';
  if not found then
    raise exception 'Barang masuk % gak ditemukan', p_goods_note_id;
  end if;
  if v_note.journal_entry_id is null or v_note.transaction_id is null then
    raise exception 'Barang masuk % berasal dari alur lama -- batalkan lewat tagihannya (kalau ada)', v_note.source_ref;
  end if;
  if exists (select 1 from goods_note_cancellations c where c.goods_note_id = p_goods_note_id) then
    raise exception 'Barang masuk % sudah dibatalkan', v_note.source_ref;
  end if;

  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || v_note.transaction_id::text));
  if p_entry_date < v_note.note_date then
    raise exception 'Tanggal pembatalan % lebih awal dari tanggal barang masuk % -- histori stok jadi janggal', p_entry_date, v_note.note_date;
  end if;
  perform assert_period_open(p_entry_date);

  for v_item in
    select item_id, sum(qty) as qty,
           sum(round(qty * unit_cost, 2) - coalesce(discount_amount, 0)) as net_value
    from goods_note_lines where goods_note_id = p_goods_note_id
    group by item_id order by item_id
  loop
    select name into v_item_name from items where id = v_item.item_id;

    if purchase_returned_qty(v_note.transaction_id, v_item.item_id) > 0 then
      raise exception 'Barang masuk % gak bisa dibatalkan: item "%" sudah punya retur/tukar barang di tagihannya -- pakai Koreksi Barang Masuk',
        v_note.source_ref, v_item_name;
    end if;

    select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
      from inventory_balances where item_id = v_item.item_id for update;

    v_pool := coalesce(v_qty_on_hand, 0);
    if not found or v_pool < v_item.qty then
      raise exception 'Barang masuk % gak bisa dibatalkan: stok "%" tinggal %, kurang dari qty diterima % (sebagian sudah terpakai/terjual) -- pakai Koreksi Barang Masuk',
        v_note.source_ref, v_item_name, v_pool, v_item.qty;
    end if;

    v_new_pool := v_pool - v_item.qty;
    v_new_value := v_pool * v_avg_cost - v_item.net_value;
    if v_new_pool > 0 and v_new_value <= 0 then
      raise exception 'Barang masuk % gak bisa dibatalkan: nilai persediaan "%" sisa gak cukup buat dibalik -- pakai Koreksi Barang Masuk',
        v_note.source_ref, v_item_name;
    end if;

    update inventory_balances
      set qty_on_hand = v_qty_on_hand - v_item.qty,
          avg_cost = case when v_new_pool > 0 then v_new_value / v_new_pool else avg_cost end,
          updated_at = now()
      where item_id = v_item.item_id;
  end loop;

  for v_line in select id, item_id, qty from goods_note_lines where goods_note_id = p_goods_note_id
  loop
    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line.item_id, p_entry_date, -v_line.qty, v_line.id);
  end loop;

  v_reversal_id := reverse_journal_entry(v_note.journal_entry_id, p_entry_date, v_note.source_ref || '/BTL');

  insert into goods_note_cancellations (goods_note_id, journal_entry_id, cancelled_by)
  values (p_goods_note_id, v_reversal_id, auth.uid());

  perform recompute_transaction_status(v_note.transaction_id);
  if v_note.order_id is not null then
    perform recompute_order_status(v_note.order_id);
  end if;

  return v_reversal_id;
end;
$$;

-- cancel_ap_bill -- sama persis 0058 kecuali: guard pembayaran hanya menghitung pembayaran aktif; penerapan uang muka
-- dan koreksi tagihan ikut dibalik (bukan ditolak), mirror cancel_ar_invoice; cek sudah-dibatalkan berlaku untuk semua
-- tagihan (dulu cuma tagihan berbarang, tagihan polos bisa dibalik dua kali).
create or replace function cancel_ap_bill(
  p_bill_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_allocated_count int; v_return_count int; v_replacement_count int;
  v_original_entry_id uuid; v_new_entry_id uuid; v_bill_ref text;
  v_has_bundled boolean; v_has_pool boolean;
  v_note record; v_line record; v_order record; v_application record; v_adjustment record;
  v_qty_on_hand numeric; v_avg_cost numeric;
  v_pool numeric; v_net_value numeric; v_new_pool numeric; v_new_value numeric; v_item_name text;
begin
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || p_bill_id::text));
  -- lock kolam juga: tanpa ini pembatalan tagihan bisa berpapasan dengan barang masuk / pelepasan kolam yang
  -- sedang berjalan (cek "tidak ada barang masuk aktif" lulus lalu barang masuk commit). Urutan lock: cancel_transaction -> pool.
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || p_bill_id::text));
  select source_ref, journal_entry_id into v_bill_ref, v_original_entry_id
    from transactions where id = p_bill_id and type = 'INBOUND';
  if not found then
    raise exception 'Bill % gak ditemukan', p_bill_id;
  end if;

  if exists (select 1 from journal_entries je where je.reverses_entry_id = v_original_entry_id) then
    raise exception 'Bill % udah pernah dibatalkan', v_bill_ref;
  end if;

  select count(*) into v_allocated_count
  from payments p
  where p.transaction_id = p_bill_id and p.type = 'INBOUND'
    and not exists (select 1 from payment_cancellations c where c.payment_id = p.id);

  if v_allocated_count > 0 then
    raise exception 'Bill % masih punya % pembayaran aktif -- batalkan pembayarannya dulu', v_bill_ref, v_allocated_count;
  end if;

  select count(*) into v_return_count
  from returns where transaction_id = p_bill_id and type = 'OUTBOUND';

  if v_return_count > 0 then
    raise exception 'Bill % udah punya % retur -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_return_count;
  end if;

  select exists (
    select 1 from goods_notes where transaction_id = p_bill_id and type = 'INBOUND' and journal_entry_id is null
  ) into v_has_bundled;
  select exists (select 1 from ap_bill_goods_pools where transaction_id = p_bill_id) into v_has_pool;

  if v_has_bundled or v_has_pool then
    select count(*) into v_replacement_count from replacements where transaction_id = p_bill_id;

    if v_replacement_count > 0 then
      raise exception 'Bill % (barang masuk) udah punya tukar barang -- urus itu dulu sebelum dibatalkan', v_bill_ref;
    end if;
  end if;

  if v_has_pool then
    if exists (
      select 1 from goods_notes gn
      where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and gn.journal_entry_id is not null
        and not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
    ) then
      raise exception 'Bill % masih punya barang masuk aktif -- batalkan barang masuknya dulu', v_bill_ref;
    end if;
    if exists (select 1 from bill_pool_releases where transaction_id = p_bill_id) then
      raise exception 'Bill % sudah punya penutupan sisa barang -- penutupan gak bisa dibatalkan, jadi tagihannya juga gak bisa. Nilai yang salah dikoreksi lewat Koreksi Tagihan', v_bill_ref;
    end if;
  end if;

  -- tagihan lama (barang masuk dibuat bareng tagihannya): stok dibalik (seperti 0053), avg_cost dari stok sudah-ditagih
  for v_note in
    select gn.id from goods_notes gn
    where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and gn.journal_entry_id is null
  loop
    for v_line in
      select id, item_id, qty, unit_cost, coalesce(discount_amount, 0) as discount_amount
      from goods_note_lines where goods_note_id = v_note.id
    loop
      select name into v_item_name from items where id = v_line.item_id;
      select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
        from inventory_balances where item_id = v_line.item_id for update;

      v_pool := coalesce(v_qty_on_hand, 0);

      if not found or v_pool < v_line.qty then
        raise exception 'Barang masuk % gak bisa dibatalkan: stok "%" tinggal %, kurang dari qty diterima % (sebagian sudah terpakai/terjual). Barang masuk lama gak punya jalur koreksi -- hubungi admin',
          v_bill_ref, v_item_name, v_pool, v_line.qty;
      end if;

      v_net_value := v_line.qty * v_line.unit_cost - v_line.discount_amount;
      v_new_pool := v_pool - v_line.qty;
      v_new_value := v_pool * v_avg_cost - v_net_value;

      if v_new_pool > 0 and v_new_value <= 0 then
        raise exception 'Barang masuk % gak bisa dibatalkan: nilai persediaan "%" sisa gak cukup buat dibalik. Barang masuk lama gak punya jalur koreksi -- hubungi admin',
          v_bill_ref, v_item_name;
      end if;

      update inventory_balances
        set qty_on_hand = v_qty_on_hand - v_line.qty,
            avg_cost = case when v_new_pool > 0 then v_new_value / v_new_pool else avg_cost end,
            updated_at = now()
        where item_id = v_line.item_id;

      insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
      values (v_line.item_id, p_entry_date, -v_line.qty, v_line.id);
    end loop;
  end loop;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select da.journal_entry_id from deposit_applications da
    where da.transaction_id = p_bill_id
      and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  for v_adjustment in
    select a.journal_entry_id from ap_bill_adjustments a
    where a.transaction_id = p_bill_id
      and not exists (select 1 from journal_entries je where je.reverses_entry_id = a.journal_entry_id)
  loop
    perform reverse_journal_entry(v_adjustment.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  -- status transaksi sudah 'dibatalkan' (trigger journal_entries) -> qty PO dihitung ulang.
  for v_order in
    select distinct gn.order_id from goods_notes gn
    where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and gn.order_id is not null
  loop
    perform recompute_order_status(v_order.order_id);
  end loop;

  return v_new_entry_id;
end;
$$;

-- ap_bill_cancellation_preview -- daftar yang akan ikut dibatalkan + penghalangnya, dibaca modal Batalkan Tagihan.
-- Hanya pratinjau: cancel_ap_bill_cascade tetap memeriksa ulang semuanya di dalam kunci.
create function ap_bill_cancellation_preview(p_bill_id uuid) returns jsonb
language plpgsql stable
security invoker
as $$
declare
  v_bill transactions%rowtype;
  v_blockers text[] := '{}';
  v_item record;
  v_count int;
begin
  select * into v_bill from transactions where id = p_bill_id and type = 'INBOUND';
  if not found then
    raise exception 'Tagihan % gak ditemukan', p_bill_id;
  end if;

  if v_bill.status = 'dibatalkan' then
    v_blockers := v_blockers || 'Tagihan ini sudah dibatalkan.';
  end if;

  select count(*) into v_count from returns where transaction_id = p_bill_id and type = 'OUTBOUND';
  if v_count > 0 then
    v_blockers := v_blockers || format('Sudah ada %s retur ke supplier, dan retur belum bisa dibatalkan. Nilai yang salah dikoreksi lewat Koreksi Tagihan.', v_count);
  end if;

  select count(*) into v_count from replacements where transaction_id = p_bill_id;
  if v_count > 0 then
    v_blockers := v_blockers || format('Sudah ada %s tukar barang, dan tukar barang belum bisa dibatalkan.', v_count);
  end if;

  select count(*) into v_count from bill_pool_releases where transaction_id = p_bill_id;
  if v_count > 0 then
    v_blockers := v_blockers || 'Sisa barang sudah pernah ditutup, dan penutupan tidak bisa dibatalkan. Nilai yang salah dikoreksi lewat Koreksi Tagihan.';
  end if;

  for v_item in
    select l.item_id, i.name, sum(l.qty) as qty,
           sum(round(l.qty * l.unit_cost, 2) - coalesce(l.discount_amount, 0)) as net_value,
           coalesce(b.qty_on_hand, 0) as on_hand, coalesce(b.avg_cost, 0) as avg_cost,
           bool_or(gn.journal_entry_id is null) as is_legacy
    from goods_notes gn
    join goods_note_lines l on l.goods_note_id = gn.id
    join items i on i.id = l.item_id
    left join inventory_balances b on b.item_id = l.item_id
    where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and goods_note_is_active(gn.id)
    group by l.item_id, i.name, b.qty_on_hand, b.avg_cost
  loop
    if v_item.on_hand < v_item.qty then
      v_blockers := v_blockers || format(
        'Stok "%s" tinggal %s, kurang dari %s yang diterima lewat tagihan ini karena sebagian sudah terjual. %s',
        v_item.name, trim_scale(v_item.on_hand), trim_scale(v_item.qty),
        case when v_item.is_legacy then 'Barang masuk lama belum punya jalur koreksi, hubungi admin.'
             else 'Perbaiki lewat Koreksi Barang Masuk dan Koreksi Tagihan.' end);
    elsif v_item.on_hand > v_item.qty and v_item.on_hand * v_item.avg_cost - v_item.net_value <= 0 then
      v_blockers := v_blockers || format(
        'Nilai stok "%s" tidak cukup untuk dibalik karena harganya sudah tercampur penjualan. %s',
        v_item.name,
        case when v_item.is_legacy then 'Barang masuk lama belum punya jalur koreksi, hubungi admin.'
             else 'Perbaiki lewat Koreksi Barang Masuk dan Koreksi Tagihan.' end);
    end if;
  end loop;

  return jsonb_build_object(
    'bill_ref', v_bill.source_ref,
    'amount', v_bill.amount,
    'goods_receipts', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'source_ref', o.source_ref, 'total_value', o.total_value) order by o.note_date)
      from goods_receipts_overview o
      where o.bill_id = p_bill_id and o.status = 'aktif' and not o.is_legacy
    ), '[]'::jsonb),
    'legacy_goods_receipts', (select count(*) from goods_receipts_overview o where o.bill_id = p_bill_id and o.status = 'aktif' and o.is_legacy),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'source_ref', p.source_ref, 'amount', p.amount, 'payment_date', p.payment_date) order by p.payment_date)
      from payments p
      where p.transaction_id = p_bill_id and p.type = 'INBOUND'
        and not exists (select 1 from payment_cancellations c where c.payment_id = p.id)
    ), '[]'::jsonb),
    'deposit_applications', coalesce((
      select jsonb_agg(jsonb_build_object('source_ref', da.source_ref, 'amount', da.amount))
      from deposit_applications da
      where da.transaction_id = p_bill_id
        and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
    ), '[]'::jsonb),
    'adjustments', coalesce((
      select jsonb_agg(jsonb_build_object('source_ref', a.source_ref, 'amount', a.amount))
      from ap_bill_adjustments a where a.transaction_id = p_bill_id
    ), '[]'::jsonb),
    'blockers', to_jsonb(v_blockers)
  );
end;
$$;

grant execute on function ap_bill_cancellation_preview(uuid) to authenticated;

-- cancel_ap_bill_cascade -- Batalkan Tagihan satu tombol: barang masuk aktif, pembayaran aktif, lalu tagihannya (kebalikan
-- urutan pencatatan), semua dalam satu transaksi. Gagal satu = gagal semua, gak ada keadaan setengah batal.
create function cancel_ap_bill_cascade(
  p_bill_id uuid,
  p_entry_date date,
  p_reason text,
  p_money_moved boolean default null -- wajib kalau ada pembayaran aktif (divalidasi cancel_payment)
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_note record;
  v_payment record;
  v_reversal_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || p_bill_id::text));

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Alasan pembatalan wajib diisi';
  end if;

  -- Urutan lock wajib goods_receipt -> pool (lihat cancel_goods_receipt/revise_goods_receipt). Kunci semua barang masuk
  -- berurutan id SEBELUM kolam terkunci, kalau tidak bisa deadlock dengan koreksi barang masuk yang berjalan bersamaan.
  perform pg_advisory_xact_lock(hashtext('goods_receipt:' || gn.id::text))
    from goods_notes gn
    where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and gn.journal_entry_id is not null
    order by gn.id;

  for v_note in
    select gn.id from goods_notes gn
    where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and gn.journal_entry_id is not null
      and not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
    order by gn.created_at desc
  loop
    perform cancel_goods_receipt(v_note.id, p_entry_date);
  end loop;

  for v_payment in
    select p.id from payments p
    where p.transaction_id = p_bill_id and p.type = 'INBOUND'
      and not exists (select 1 from payment_cancellations c where c.payment_id = p.id)
    order by p.created_at desc
  loop
    perform cancel_payment(v_payment.id, p_entry_date, p_reason, p_money_moved);
  end loop;

  v_reversal_id := cancel_ap_bill(p_bill_id, p_entry_date, generate_document_number('journal_entries'));

  insert into ap_bill_cancellations (transaction_id, reason, cancelled_by)
  values (p_bill_id, trim(p_reason), auth.uid());

  return v_reversal_id;
end;
$$;

grant execute on function cancel_ap_bill_cascade(uuid, date, text, boolean) to authenticated;

-- ============================================================================================
-- 5. Koreksi Tagihan (nota kredit / nota debit supplier)
-- ============================================================================================

-- adjust_ap_bill -- p_amount + = tagihan naik: Debit Pembelian Belum Diterima, Kredit Utang Usaha.
--                   p_amount - = tagihan turun: Debit Utang Usaha, Kredit Pembelian Belum Diterima.
-- Hanya tagihan barang: nilainya harus punya pasangan di sisa barang supaya saldo Pembelian Belum Diterima tetap sama
-- dengan jumlah sisa semua tagihan. Penurunan dibatasi sisa barang dan sisa utang; bagian yang sudah dibayar keluar lewat
-- Tutup Sisa Barang (uang muka).
create function adjust_ap_bill(
  p_bill_id uuid,
  p_amount numeric,
  p_adjustment_date date,
  p_reason text,
  p_supplier_document_ref text default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_bill transactions%rowtype;
  v_pbd_account_id uuid;
  v_payable_account_id uuid;
  v_remaining_pool numeric;
  v_remaining_debt numeric;
  v_source_ref text;
  v_entry_id uuid;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || p_bill_id::text));
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || p_bill_id::text));

  select * into v_bill from transactions where id = p_bill_id and type = 'INBOUND';
  if not found then
    raise exception 'Tagihan % gak ditemukan', p_bill_id;
  end if;
  if v_bill.status = 'dibatalkan' then
    raise exception 'Tagihan % sudah dibatalkan', v_bill.source_ref;
  end if;
  if not exists (select 1 from ap_bill_goods_pools where transaction_id = p_bill_id) then
    raise exception 'Koreksi Tagihan hanya untuk Tagihan Barang; % bukan Tagihan Barang', v_bill.source_ref;
  end if;

  if p_amount is null or p_amount = 0 then
    raise exception 'Nominal koreksi gak boleh 0';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception 'Nominal koreksi maksimal 2 desimal';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Alasan koreksi wajib diisi';
  end if;
  if p_adjustment_date < v_bill.date then
    raise exception 'Tanggal koreksi % lebih awal dari tanggal tagihan %', p_adjustment_date, v_bill.date;
  end if;
  perform assert_period_open(p_adjustment_date);

  if p_amount < 0 then
    v_remaining_pool := ap_bill_pool_remaining(p_bill_id);
    v_remaining_debt := ap_bill_remaining(p_bill_id);
    if -p_amount > v_remaining_pool then
      raise exception 'Penurunan % melebihi barang yang belum diterima dari tagihan % (sisa %) -- kurangi dulu barang masuknya lewat Koreksi Barang Masuk',
        -p_amount, v_bill.source_ref, v_remaining_pool;
    end if;
    if -p_amount > v_remaining_debt then
      raise exception 'Penurunan % melebihi sisa utang tagihan % (sisa %) -- bagian yang sudah dibayar keluar lewat Tutup Sisa Barang jadi uang muka, atau batalkan pembayarannya dulu kalau catatannya salah',
        -p_amount, v_bill.source_ref, v_remaining_debt;
    end if;
  end if;

  select account_id into v_pbd_account_id
    from app_default_account_settings where role_key = 'inventory.purchase_not_received';
  if v_pbd_account_id is null then
    raise exception 'Default Akun "Pembelian Belum Diterima" belum diset -- cek Pengaturan > Default Akun';
  end if;
  -- akun utang mengikuti jurnal tagihan aslinya, bukan Default Akun saat ini (yang bisa sudah dipetakan ulang)
  select jl.account_id into v_payable_account_id
    from journal_lines jl where jl.journal_entry_id = v_bill.journal_entry_id and jl.credit > 0 limit 1;
  if v_payable_account_id is null then
    raise exception 'Akun Utang Usaha tagihan % gak ketemu di jurnalnya', v_bill.source_ref;
  end if;

  v_source_ref := generate_document_number('ap_bill_adjustments');

  v_entry_id := create_journal_entry(
    p_adjustment_date, 'Koreksi tagihan ' || v_bill.source_ref, v_source_ref,
    case when p_amount > 0 then
      jsonb_build_array(
        jsonb_build_object('account_id', v_pbd_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', v_payable_account_id, 'debit', 0, 'credit', p_amount)
      )
    else
      jsonb_build_array(
        jsonb_build_object('account_id', v_payable_account_id, 'debit', -p_amount, 'credit', 0),
        jsonb_build_object('account_id', v_pbd_account_id, 'debit', 0, 'credit', -p_amount)
      )
    end
  );

  insert into ap_bill_adjustments (transaction_id, amount, adjustment_date, source_ref, supplier_document_ref, reason, journal_entry_id, created_by)
  values (p_bill_id, p_amount, p_adjustment_date, v_source_ref, nullif(trim(coalesce(p_supplier_document_ref, '')), ''), trim(p_reason), v_entry_id, auth.uid())
  returning id into v_id;

  perform recompute_transaction_status(p_bill_id);

  return v_id;
end;
$$;

grant execute on function adjust_ap_bill(uuid, numeric, date, text, text) to authenticated;

-- ============================================================================================
-- 6. Koreksi Barang Masuk
-- ============================================================================================

-- goods_receipt_stock_share -- porsi nilai barang masuk yang MASIH di stok, dari mutasi keluar sesudahnya.
-- Rata-rata tertimbang: tiap kali keluar o dari stok Q, nilai di dalam stok ikut keluar sebanyak o/Q. Mundur dari stok
-- sekarang supaya gak perlu menyimpan saldo historis. Hasil 1 = belum ada yang keluar.
create function goods_receipt_stock_share(p_goods_note_id uuid, p_item_id uuid, p_qty_on_hand numeric) returns numeric
language plpgsql stable
as $$
declare
  v_note_created timestamptz;
  v_share numeric := 1;
  v_qty numeric := p_qty_on_hand;
  v_before numeric;
  v_move record;
begin
  select created_at into v_note_created from goods_notes where id = p_goods_note_id;

  for v_move in
    select qty from inventory_movements
    where item_id = p_item_id and created_at > v_note_created
    order by created_at desc, id desc
  loop
    v_before := v_qty - v_move.qty;
    if v_move.qty < 0 and v_before > 0 then
      v_share := v_share * greatest(v_qty, 0) / v_before;
    end if;
    v_qty := v_before;
  end loop;

  return least(greatest(v_share, 0), 1);
end;
$$;

-- revise_goods_receipt -- ganti barang masuk yang salah (item/qty/harga) dengan yang benar. Dokumen lama dibatalkan, dokumen
-- baru dibuat lewat create_goods_receipt, jadi retur, sisa barang, PO, dan pembatalan tetap bekerja tanpa cabang khusus.
-- Beda dari cancel_goods_receipt: yang dicek cuma SELISIH qty, jadi tetap jalan walau sebagian sudah terjual.
--
-- Per item (q0,v0 = lama; q1,v1 = baru; Q,V = stok sekarang):
--   selisih qty dianggap seluruhnya masih di stok, pada biaya yang tercatat;
--   selisih harga atas qty yang sama (min(q0,q1)) dibagi: porsi yang masih di stok ke Persediaan, sisanya (barang yang sudah
--   keluar) ke HPP periode berjalan -- periode lama gak boleh diubah.
-- Pembagian ini perkiraan kalau harga stok lain jauh berbeda dan sudah ada penjualan; total jurnal tetap seimbang dan nilai
-- stok tetap cocok dengan buku besar.
create function revise_goods_receipt(
  p_goods_note_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- format sama create_goods_receipt
  p_discount_amount numeric,
  p_reason text,
  p_entry_date date
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_note goods_notes%rowtype;
  v_inventory_account_id uuid;
  v_hpp_account_id uuid;
  v_new_note_id uuid;
  v_new_source_ref text;
  v_reversal_id uuid;
  v_before jsonb := '{}'::jsonb;
  v_snapshot jsonb;
  v_item record;
  v_line record;
  v_on_hand numeric;
  v_avg numeric;
  v_share numeric;
  v_q0 numeric; v_v0 numeric; v_q1 numeric; v_v1 numeric;
  v_value numeric; v_new_qty numeric; v_new_value numeric; v_delta numeric; v_price_part numeric; v_stock_part numeric;
  v_unit numeric;
  v_item_name text;
  v_cogs numeric := 0;
  v_cogs_entry_id uuid;
  v_claimed numeric;
  v_active_qty numeric;
begin
  perform pg_advisory_xact_lock(hashtext('goods_receipt:' || p_goods_note_id::text));

  select * into v_note from goods_notes where id = p_goods_note_id and type = 'INBOUND';
  if not found then
    raise exception 'Barang masuk % gak ditemukan', p_goods_note_id;
  end if;
  if v_note.journal_entry_id is null or v_note.transaction_id is null then
    raise exception 'Barang masuk ini berasal dari alur lama dan belum punya jalur koreksi -- batalkan lewat tagihannya';
  end if;
  if exists (select 1 from goods_note_cancellations c where c.goods_note_id = p_goods_note_id) then
    raise exception 'Barang masuk % sudah dibatalkan', v_note.source_ref;
  end if;

  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || v_note.transaction_id::text));

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Alasan koreksi wajib diisi';
  end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Koreksi butuh minimal 1 baris barang -- kalau barangnya memang gak ada, pakai Batalkan Barang Masuk';
  end if;
  if p_entry_date < v_note.note_date then
    raise exception 'Tanggal koreksi % lebih awal dari tanggal barang masuk %', p_entry_date, v_note.note_date;
  end if;
  perform assert_period_open(p_entry_date);

  select jl.account_id into v_inventory_account_id
    from journal_lines jl where jl.journal_entry_id = v_note.journal_entry_id and jl.debit > 0 limit 1;

  select account_id into v_hpp_account_id from app_default_account_settings where role_key = 'inventory.hpp';
  if v_hpp_account_id is null then
    raise exception 'Default Akun "inventory.hpp" belum diset -- cek Pengaturan > Default Akun';
  end if;

  -- foto stok SEBELUM apa pun diubah (kunci berurutan item_id, hindari deadlock)
  for v_item in
    select item_id from goods_note_lines where goods_note_id = p_goods_note_id
    union
    select (t.value->>'item_id')::uuid from jsonb_array_elements(p_lines) as t(value)
    order by item_id
  loop
    select qty_on_hand, avg_cost into v_on_hand, v_avg from inventory_balances where item_id = v_item.item_id for update;
    v_on_hand := coalesce(v_on_hand, 0);
    v_avg := coalesce(v_avg, 0);
    v_before := v_before || jsonb_build_object(v_item.item_id::text, jsonb_build_object(
      'q', v_on_hand, 'a', v_avg, 's', goods_receipt_stock_share(p_goods_note_id, v_item.item_id, v_on_hand)));
  end loop;

  -- batalkan dokumen lama TANPA sentuh saldo stok: saldo final ditulis di bawah dari foto di atas
  for v_line in select id, item_id, qty from goods_note_lines where goods_note_id = p_goods_note_id
  loop
    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line.item_id, p_entry_date, -v_line.qty, v_line.id);
  end loop;

  v_reversal_id := reverse_journal_entry(v_note.journal_entry_id, p_entry_date, v_note.source_ref || '/BTL');

  insert into goods_note_cancellations (goods_note_id, journal_entry_id, cancelled_by)
  values (p_goods_note_id, v_reversal_id, auth.uid());

  v_new_note_id := create_goods_receipt(
    v_note.transaction_id, p_receipt_date, p_delivery_note_ref, p_lines, v_inventory_account_id,
    v_note.order_id, coalesce(p_discount_amount, 0)
  );

  select source_ref into v_new_source_ref from goods_notes where id = v_new_note_id;

  -- saldo final per item
  for v_item in
    select item_id from goods_note_lines where goods_note_id = p_goods_note_id
    union
    select item_id from goods_note_lines where goods_note_id = v_new_note_id
    order by item_id
  loop
    v_snapshot := v_before -> v_item.item_id::text;
    v_on_hand := (v_snapshot->>'q')::numeric;
    v_avg := (v_snapshot->>'a')::numeric;
    v_share := (v_snapshot->>'s')::numeric;

    select coalesce(sum(qty), 0), coalesce(sum(round(qty * unit_cost, 2) - coalesce(discount_amount, 0)), 0)
      into v_q0, v_v0 from goods_note_lines where goods_note_id = p_goods_note_id and item_id = v_item.item_id;
    select coalesce(sum(qty), 0), coalesce(sum(round(qty * unit_cost, 2) - coalesce(discount_amount, 0)), 0)
      into v_q1, v_v1 from goods_note_lines where goods_note_id = v_new_note_id and item_id = v_item.item_id;

    v_new_qty := v_on_hand + v_q1 - v_q0;
    if v_new_qty < 0 then
      select name into v_item_name from items where id = v_item.item_id;
      raise exception 'Koreksi ditolak: stok "%" tercatat tinggal %, gak cukup dikurangi % -- hitung fisik dulu lewat Stock Opname',
        v_item_name, v_on_hand, v_q0 - v_q1;
    end if;

    v_value := v_on_hand * v_avg;
    v_delta := v_v1 - v_v0;
    if v_q0 > 0 and v_q1 > 0 then
      v_price_part := least(v_q0, v_q1) * (v_v1 / v_q1 - v_v0 / v_q0);
      v_stock_part := (v_delta - v_price_part) + v_share * v_price_part;
    else
      v_stock_part := v_delta;
    end if;
    v_new_value := v_value + v_stock_part;

    if v_new_qty = 0 then
      v_new_value := 0;
    elsif v_new_value <= 0 then
      -- harga stok tercampur terlalu jauh: sisa stok dinilai pada harga yang benar, sisanya ke HPP
      v_unit := case when v_q1 > 0 then v_v1 / v_q1 else v_avg end;
      v_new_value := v_new_qty * v_unit;
    end if;

    v_cogs := v_cogs + (v_delta - (v_new_value - v_value));

    -- create_goods_receipt sudah menambah stok; ditimpa dengan hasil akhir
    update inventory_balances
      set qty_on_hand = v_new_qty,
          avg_cost = case when v_new_qty > 0 then v_new_value / v_new_qty else v_avg end,
          updated_at = now()
      where item_id = v_item.item_id;

    v_claimed := purchase_returned_qty(v_note.transaction_id, v_item.item_id);
    if v_claimed > 0 then
      select coalesce(sum(gnl.qty), 0) into v_active_qty
        from goods_notes gn join goods_note_lines gnl on gnl.goods_note_id = gn.id
        where gn.transaction_id = v_note.transaction_id and gn.type = 'INBOUND'
          and goods_note_is_active(gn.id) and gnl.item_id = v_item.item_id;
      if v_active_qty < v_claimed then
        select name into v_item_name from items where id = v_item.item_id;
        raise exception 'Koreksi ditolak: "%" sudah diretur/ditukar %, sedangkan qty diterima setelah koreksi tinggal %',
          v_item_name, v_claimed, v_active_qty;
      end if;
    end if;
  end loop;

  v_cogs := round(v_cogs, 2);
  if v_cogs <> 0 then
    v_cogs_entry_id := create_journal_entry(
      p_entry_date, 'Koreksi HPP dari koreksi barang masuk ' || v_note.source_ref, v_new_source_ref,
      case when v_cogs > 0 then
        jsonb_build_array(
          jsonb_build_object('account_id', v_hpp_account_id, 'debit', v_cogs, 'credit', 0),
          jsonb_build_object('account_id', v_inventory_account_id, 'debit', 0, 'credit', v_cogs)
        )
      else
        jsonb_build_array(
          jsonb_build_object('account_id', v_inventory_account_id, 'debit', -v_cogs, 'credit', 0),
          jsonb_build_object('account_id', v_hpp_account_id, 'debit', 0, 'credit', -v_cogs)
        )
      end
    );
  end if;

  insert into goods_receipt_revisions (old_goods_note_id, new_goods_note_id, reason, cogs_adjustment, cogs_journal_entry_id, created_by)
  values (p_goods_note_id, v_new_note_id, trim(p_reason), v_cogs, v_cogs_entry_id, auth.uid());

  perform recompute_transaction_status(v_note.transaction_id);
  if v_note.order_id is not null then
    perform recompute_order_status(v_note.order_id);
  end if;

  return v_new_note_id;
end;
$$;

grant execute on function revise_goods_receipt(uuid, date, text, jsonb, numeric, text, date) to authenticated;

-- ============================================================================================
-- 7. Retur ke supplier: akun kredit dijaga
-- ============================================================================================

-- create_ap_return -- sama persis 0057 kecuali akun kredit divalidasi: Pembelian Belum Diterima ditolak (kolam gak ikut
-- turun, saldonya jadi gak cocok), dan retur barang fisik wajib mengkredit akun Persediaan (stok turun, Persediaan harus ikut).
create or replace function create_ap_return(
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
  -- serialisasi dengan pembatalan barang masuk / barang masuk baru di tagihan yang sama (lock yang sama)
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || p_bill_id::text));

  if p_credit_account_id = (select account_id from app_default_account_settings where role_key = 'inventory.purchase_not_received') then
    raise exception 'Retur gak boleh mengkredit akun Pembelian Belum Diterima -- untuk barang yang belum datang pakai Koreksi Tagihan';
  end if;

  select ap_bill_remaining(p_bill_id) into v_remaining_before;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    if not exists (select 1 from items where inventory_account_id = p_credit_account_id)
       and p_credit_account_id is distinct from (select account_id from app_default_account_settings where role_key = 'inventory.raw_material')
       and p_credit_account_id is distinct from (select account_id from app_default_account_settings where role_key = 'inventory.finished_good') then
      raise exception 'Retur barang fisik wajib mengkredit akun Persediaan';
    end if;

    if not exists (
      select 1 from goods_notes gn
      where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and goods_note_is_active(gn.id)
    ) then
      raise exception 'Bill % gak punya goods receipt -- gak bisa retur stok', p_bill_id;
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

commit;
