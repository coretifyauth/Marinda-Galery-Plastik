-- 0061 Batalkan Retur ke Supplier (Opsi A).
-- Retur selama ini tidak punya jalur pembatalan, sehingga tagihan yang diretur penuh karena salah input tidak bisa dibatalkan
-- (cancel_ap_bill/cancel_goods_receipt menolak tagihan yang punya retur). Migration ini menambah tabel pendamping
-- return_cancellations (append-only, pola payment_cancellations) dan fungsi cancel_ap_return, lalu membuat semua tempat yang
-- menghitung retur hanya melihat retur AKTIF (return_is_active):
--   ap_bill_remaining, purchase_returned_qty, return_credit_remaining, cancel_payment, cancel_ap_bill,
--   ap_bill_cancellation_preview, label Kartu Stok. Isi fungsi lain sama persis dengan 0060 / 0019 / 0020 / 0052.
-- Hanya retur ke supplier (type OUTBOUND, Opsi A). Tukar barang (Opsi B) dan retur customer (AR) tidak berubah.

-- ============================================================================================
-- 1. Tabel pendamping + penanda retur aktif
-- ============================================================================================

create table return_cancellations (
  return_id uuid primary key references returns(id),
  journal_entry_id uuid not null references journal_entries(id),            -- pembalik jurnal retur
  credit_journal_entry_id uuid references journal_entries(id),              -- pembalik jurnal saldo Piutang Retur Supplier (kalau ada)
  reason text not null check (length(trim(reason)) > 0),
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz not null default now()
);

create trigger return_cancellations_block_edit_delete
  before update or delete on return_cancellations
  for each row execute function block_edit_delete();

alter table return_cancellations enable row level security;

create policy return_cancellations_select on return_cancellations
  for select using (auth.role() = 'authenticated');

create policy return_cancellations_insert on return_cancellations
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on return_cancellations to authenticated;

create function return_is_active(p_return_id uuid) returns boolean
language sql stable
as $$
  select not exists (select 1 from return_cancellations c where c.return_id = p_return_id)
$$;

-- ============================================================================================
-- 2. Perhitungan yang hanya melihat retur aktif
-- ============================================================================================

-- ap_bill_remaining -- sama persis 0060 kecuali retur dan saldo retur yang sudah dibatalkan tidak dihitung.
create or replace function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
declare
  v_result numeric;
begin
  select ab.amount
    + ap_bill_adjustments_total(p_bill_id)
    - transaction_active_payments(p_bill_id, 'INBOUND')
    - coalesce((select sum(amount) from returns where transaction_id = p_bill_id and type = 'OUTBOUND' and return_is_active(id)), 0)
    - coalesce((
        select sum(da.amount) from deposit_applications da
        where da.transaction_id = p_bill_id
          and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
      ), 0)
    + coalesce((
        select sum(rc.amount) from return_credits rc
        join returns r on r.id = rc.return_id
        where r.transaction_id = p_bill_id and return_is_active(r.id)
      ), 0)
  into v_result
  from transactions ab
  where ab.id = p_bill_id;
  return v_result;
end;
$$ language plpgsql stable;

-- purchase_returned_qty -- sama persis 0019 kecuali retur (Opsi A) yang dibatalkan tidak dihitung. Tukar barang tidak berubah.
create or replace function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
declare
  v_result numeric;
begin
  select
    coalesce((
      select sum(rl.qty_returned) from return_lines rl
      join returns r on r.id = rl.return_id
      where r.transaction_id = p_bill_id and rl.type = 'OUTBOUND' and rl.item_id = p_item_id
        and return_is_active(r.id)
    ), 0)
    +
    coalesce((
      select sum(rpl.qty_replaced) from replacement_lines rpl
      join replacements rp on rp.id = rpl.replacement_id
      where rp.transaction_id = p_bill_id and rp.type = 'OUTBOUND' and rpl.item_id = p_item_id
    ), 0)
  into v_result;
  return v_result;
end;
$$ language plpgsql stable;

-- credit_notes_no_over_return -- sama persis 0019 kecuali retur yang dibatalkan tidak dihitung ke batas nilai transaksi
-- (tanpa ini, tagihan yang diretur penuh lalu dibatalkan returnya tidak bisa diretur ulang dengan benar).
create or replace function credit_notes_no_over_return() returns trigger as $$
declare
  v_transaction_amount numeric;
  v_already_returned numeric;
  v_transaction_ref text;
begin
  select amount into v_transaction_amount from transactions where id = new.transaction_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from returns where transaction_id = new.transaction_id and return_is_active(id);

  if v_already_returned + new.amount > v_transaction_amount then
    select source_ref into v_transaction_ref from transactions where id = new.transaction_id;
    raise exception 'Retur % melebihi nilai transaksi (nilai %, sudah diretur %, coba retur %)',
      v_transaction_ref, v_transaction_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- return_credit_remaining -- sama persis 0020, saldo dari retur yang dibatalkan = 0 (jadi tidak bisa dicairkan).
create or replace function return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select case when return_is_active(c.return_id)
              then c.amount - coalesce((select sum(amount) from return_credit_refunds where credit_id = p_credit_id), 0)
              else 0 end
  from return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

-- refund_return_credit -- sama persis 0020 kecuali mengambil advisory lock saldo lebih dulu, supaya pencairan tunai tidak bisa
-- berpapasan dengan cancel_ap_return (yang menolak saldo yang sudah dicairkan dan membalik jurnal saldonya).
create or replace function refund_return_credit(
  p_credit_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_return_credit_account_id uuid,
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
  perform pg_advisory_xact_lock(hashtext('return_credit:' || p_credit_id::text)); -- tabel ini tanpa hak UPDATE, jadi bukan FOR UPDATE
  select type into v_type from return_credits where id = p_credit_id;

  if v_type = 'INBOUND' then
    v_entry_id := create_journal_entry(
      p_entry_date, 'Refund saldo kredit retur customer', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_return_credit_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_entry_id := create_journal_entry(
      p_entry_date, 'Refund saldo kredit retur supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', p_return_credit_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  end if;

  insert into return_credit_refunds (credit_id, amount, source_ref, journal_entry_id, created_by)
  values (p_credit_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

-- ============================================================================================
-- 3. Batalkan Retur
-- ============================================================================================

-- cancel_ap_return -- membalik jurnal retur (Debit Persediaan/akun kredit retur, Kredit Utang Usaha), mengembalikan stok pada
-- NILAI yang sama dengan yang keluar saat retur (return_lines.total_cost), dan membalik jurnal saldo Piutang Retur Supplier
-- kalau retur itu menghasilkannya. Dokumen retur tetap ada; penandanya baris di return_cancellations.
-- Ditolak kalau: sudah dibatalkan, tagihan sudah dibatalkan, saldo returnya sudah (sebagian) dicairkan tunai, atau masih
-- ada retur yang lebih baru di tagihan yang sama (saldo retur yang lebih baru dihitung dengan memperhitungkan yang lama).
create function cancel_ap_return(
  p_return_id uuid,
  p_entry_date date,
  p_reason text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_return returns%rowtype;
  v_bill transactions%rowtype;
  v_credit return_credits%rowtype;
  v_newer_ref text;
  v_line record;
  v_reversal_id uuid;
  v_credit_reversal_id uuid;
begin
  select * into v_return from returns where id = p_return_id and type = 'OUTBOUND';
  if not found then
    raise exception 'Retur % gak ditemukan', p_return_id;
  end if;

  -- urutan lock sama dengan cancel_ap_bill: cancel_transaction -> kolam
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || v_return.transaction_id::text));
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || v_return.transaction_id::text));

  if not return_is_active(p_return_id) then
    raise exception 'Retur % sudah dibatalkan', v_return.source_ref;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Alasan pembatalan retur wajib diisi';
  end if;

  select * into v_bill from transactions where id = v_return.transaction_id;
  if v_bill.status = 'dibatalkan' then
    raise exception 'Tagihan % sudah dibatalkan', v_bill.source_ref;
  end if;

  if p_entry_date < v_return.credit_note_date then
    raise exception 'Tanggal pembatalan % lebih awal dari tanggal retur % -- histori stok jadi janggal', p_entry_date, v_return.credit_note_date;
  end if;
  perform assert_period_open(p_entry_date);

  select r.source_ref into v_newer_ref
    from returns r
    where r.transaction_id = v_return.transaction_id and r.type = 'OUTBOUND' and r.id <> p_return_id
      and return_is_active(r.id)
      and (r.created_at, r.id) > (v_return.created_at, v_return.id)
    order by r.created_at, r.id
    limit 1;
  if v_newer_ref is not null then
    raise exception 'Retur % gak bisa dibatalkan: masih ada retur yang lebih baru (%) di tagihan yang sama -- batalkan yang terbaru dulu',
      v_return.source_ref, v_newer_ref;
  end if;

  select * into v_credit from return_credits where return_id = p_return_id;
  if found then
    perform pg_advisory_xact_lock(hashtext('return_credit:' || v_credit.id::text)); -- kunci yang sama dengan refund_return_credit
  end if;
  if v_credit.id is not null and exists (select 1 from return_credit_refunds f where f.credit_id = v_credit.id) then
    raise exception 'Retur % gak bisa dibatalkan: saldo Piutang Retur Supplier-nya sudah dicairkan tunai (uangnya sudah kembali ke kas)', v_return.source_ref;
  end if;

  for v_line in
    select id, item_id, qty_returned, total_cost from return_lines where return_id = p_return_id order by id
  loop
    perform inventory_restore_stock(v_line.item_id, v_line.qty_returned, v_line.total_cost / v_line.qty_returned);

    insert into inventory_movements (item_id, movement_date, qty, return_line_id)
    values (v_line.item_id, p_entry_date, v_line.qty_returned, v_line.id);
  end loop;

  v_reversal_id := reverse_journal_entry(v_return.journal_entry_id, p_entry_date, v_return.source_ref || '/BTL');

  if v_credit.id is not null then
    v_credit_reversal_id := reverse_journal_entry(v_credit.journal_entry_id, p_entry_date, v_return.source_ref || '/BTL');
  end if;

  insert into return_cancellations (return_id, journal_entry_id, credit_journal_entry_id, reason, cancelled_by)
  values (p_return_id, v_reversal_id, v_credit_reversal_id, trim(p_reason), auth.uid());

  perform recompute_transaction_status(v_return.transaction_id);

  return v_reversal_id;
end;
$$;

grant execute on function cancel_ap_return(uuid, date, text) to authenticated;

-- ============================================================================================
-- 4. Fungsi yang sebelumnya menolak semua tagihan beretur -- sekarang hanya retur aktif
-- ============================================================================================

-- cancel_payment -- sama persis 0060 kecuali saldo retur yang dibatalkan tidak lagi memblokir.
create or replace function cancel_payment(
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
    where r.transaction_id = v_payment.transaction_id and return_is_active(r.id)
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

-- cancel_ap_bill -- sama persis 0060 kecuali penghitung retur hanya retur aktif.
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
  from returns where transaction_id = p_bill_id and type = 'OUTBOUND' and return_is_active(id);

  if v_return_count > 0 then
    raise exception 'Bill % masih punya % retur aktif -- batalkan returnya dulu', v_bill_ref, v_return_count;
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

-- ap_bill_cancellation_preview -- sama persis 0060 kecuali penghalang retur hanya untuk retur aktif.
create or replace function ap_bill_cancellation_preview(p_bill_id uuid) returns jsonb
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

  select count(*) into v_count from returns where transaction_id = p_bill_id and type = 'OUTBOUND' and return_is_active(id);
  if v_count > 0 then
    v_blockers := v_blockers || format('Masih ada %s retur ke supplier yang aktif. Batalkan returnya dulu (yang terbaru dulu), lalu batalkan tagihan.', v_count);
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

-- Kartu Stok -- sama persis 0052 kecuali mutasi pembatalan retur supplier (qty positif di baris retur OUTBOUND) berlabel sendiri.
create or replace view inventory_movements_with_source
  with (security_invoker = true) as
select
  im.id,
  im.item_id,
  im.movement_date,
  im.qty,
  im.created_at,
  coalesce(
    case when im.goods_note_line_id is not null and gn.type = 'INBOUND'
      then case when im.qty < 0 then 'Pembatalan Barang Masuk' else 'Pembelian (Terima Barang)' end
      else null end,
    case when im.goods_note_line_id is not null and gn.type = 'OUTBOUND' and im.qty > 0 then 'Pembatalan Barang Keluar' else null end,
    case when im.production_order_id is not null then 'Produksi (Hasil)' else null end,
    case when im.return_line_id is not null and rl.type = 'INBOUND' then 'Retur dari Customer' else null end,
    case when im.stock_opname_line_id is not null then 'Penyesuaian Stock Opname' else null end,
    case when im.goods_note_line_id is not null and gn.type = 'OUTBOUND' then 'Penjualan (Kirim Barang)' else null end,
    case when im.production_order_line_id is not null then 'Produksi (Konsumsi Bahan)' else null end,
    case when im.return_line_id is not null and rl.type = 'OUTBOUND'
      then case when im.qty > 0 then 'Pembatalan Retur ke Supplier' else 'Retur ke Supplier' end else null end,
    case when im.replacement_line_id is not null and rp.type = 'INBOUND' then 'Penggantian Garansi' else null end,
    case when im.replacement_line_id is not null and rp.type = 'OUTBOUND' then 'Tukar Barang (Retur Supplier)' else null end
  ) as source_label,
  coalesce(ap_bill.source_ref, prod_header.source_ref, r.source_ref, so.source_ref, gn.source_ref, prod_line_header.source_ref, rp.source_ref) as source_ref
from inventory_movements im
  left join goods_note_lines gnl on gnl.id = im.goods_note_line_id
  left join goods_notes gn on gn.id = gnl.goods_note_id
  left join transactions ap_bill on ap_bill.id = gn.transaction_id and gn.type = 'INBOUND'
  left join production_orders prod_header on prod_header.id = im.production_order_id
  left join return_lines rl on rl.id = im.return_line_id
  left join returns r on r.id = rl.return_id
  left join stock_opname_lines sol on sol.id = im.stock_opname_line_id
  left join stock_opnames so on so.id = sol.stock_opname_id
  left join production_order_lines pol on pol.id = im.production_order_line_id
  left join production_orders prod_line_header on prod_line_header.id = pol.production_order_id
  left join replacement_lines rpl on rpl.id = im.replacement_line_id
  left join replacements rp on rp.id = rpl.replacement_id;
