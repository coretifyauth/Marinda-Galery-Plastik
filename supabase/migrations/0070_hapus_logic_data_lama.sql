-- 0070_hapus_logic_data_lama.sql
-- Pembersihan logic "data lama" setelah seluruh data transaksional live dihapus (2026-11-04, skrip sekali-pakai di luar
-- migration; master data utuh). Semua jalur yang hanya ada untuk menangani baris lama kini tidak punya baris lagi, jadi dibuang:
--
--   1. Barang masuk lama / "bundled" (barang masuk dibuat bareng tagihannya, goods_notes INBOUND tanpa jurnal sendiri):
--      cabang journal_entry_id IS NULL di goods_note_is_active, goods_notes_inbound_from_bill_guard, cancel_ap_bill,
--      ap_bill_cancellation_preview, cancel_goods_receipt, revise_goods_receipt, recompute_transaction_status dan view
--      goods_receipts_overview (kolom is_legacy); fungsi revise_legacy_goods_receipt (0069); goods_note_cancellations
--      .journal_entry_id menjadi NOT NULL (satu-satunya penulis baris tanpa jurnal adalah fungsi itu).
--   2. Tukar Barang / Penggantian Garansi (fitur dicabut di 0063, penanda batal di 0065): tabel replacements,
--      replacement_lines, replacement_cancellations, fungsi cancel_ap_replacement dan replacement_is_active, kolom
--      inventory_movements.replacement_line_id (+ CHECK sumber mutasi jadi 5 kolom), cabang tukar barang di
--      purchase_returned_qty / sales_returned_qty / cancel_ap_bill / cancel_ar_invoice / ap_bill_cancellation_preview /
--      inventory_movements_with_source, dan jenis dokumen purchase_replacements / warranty_replacements (termasuk dari
--      bootstrap_default_accounts_base).
--
-- TIDAK disentuh: skema archive (salinan alur GRNI dari 0058, keputusan terpisah), tabel koreksi baru (goods_receipt_revisions,
-- ap_bill_adjustments, *_cancellations lain), dan semua logic untuk barang masuk dari tagihan.
-- Isi fungsi lain sama persis dengan versi live sebelumnya (0069 / 0065 / 0061 / 0060); yang berubah hanya cabang di atas.
--
-- Supabase CLI menjalankan tiap statement TERPISAH (bukan satu transaksi per file) -- transaksi harus eksplisit supaya gagal di tengah = batal semua.
begin;

-- ============================================================================================
-- 0. Pagar awal -- gagal keras kalau masih ada data yang dilayani logic yang dibuang
-- ============================================================================================

do $$
begin
  if exists (select 1 from replacements) or exists (select 1 from replacement_lines) or exists (select 1 from replacement_cancellations) then
    raise exception '0070 dibatalkan: masih ada baris tukar barang (replacements / replacement_lines / replacement_cancellations)';
  end if;
  if exists (select 1 from inventory_movements where replacement_line_id is not null) then
    raise exception '0070 dibatalkan: masih ada mutasi stok yang bersumber dari tukar barang';
  end if;
  if exists (select 1 from goods_notes where type = 'INBOUND' and (journal_entry_id is null or transaction_id is null)) then
    raise exception '0070 dibatalkan: masih ada barang masuk lama (INBOUND tanpa jurnal sendiri atau tanpa tagihan)';
  end if;
  if exists (select 1 from goods_note_cancellations where journal_entry_id is null) then
    raise exception '0070 dibatalkan: masih ada baris goods_note_cancellations tanpa jurnal (hasil koreksi barang masuk lama)';
  end if;
  if exists (select 1 from document_number_counters where doc_type in ('purchase_replacements', 'warranty_replacements')) then
    raise exception '0070 dibatalkan: counter nomor dokumen tukar barang masih terisi';
  end if;
end;
$$;

-- ============================================================================================
-- 1. Fungsi: buang cabang barang masuk lama & tukar barang
-- ============================================================================================

create or replace function goods_note_is_active(p_goods_note_id uuid) returns boolean
language sql stable
as $$
  -- Barang masuk (INBOUND) selalu punya jurnal sendiri: aktif selama belum ada baris pembatalan/penggantinya
  -- (goods_note_cancellations). Barang keluar: aktif selama tagihannya belum dibatalkan.
  select case
    when gn.type = 'INBOUND' then not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
    else coalesce(t.status, '') <> 'dibatalkan'
  end
  from goods_notes gn
  left join transactions t on t.id = gn.transaction_id
  where gn.id = p_goods_note_id
$$;

CREATE OR REPLACE FUNCTION public.goods_notes_inbound_from_bill_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_bill_type text;
  v_bill_supplier uuid;
begin
  if new.type <> 'INBOUND' then
    return new;
  end if;

  if new.transaction_id is null then
    raise exception 'Barang masuk wajib dibuat dari tagihan barang (transaction_id kosong)';
  end if;

  select type, counterparty_id into v_bill_type, v_bill_supplier from transactions where id = new.transaction_id;
  if v_bill_type is distinct from 'INBOUND' then
    raise exception 'Transaksi % bukan tagihan AP', new.transaction_id;
  end if;
  if v_bill_supplier is distinct from new.counterparty_id then
    raise exception 'Supplier barang masuk beda dengan supplier tagihan';
  end if;

  if new.journal_entry_id is null or new.source_ref is null then
    raise exception 'Barang masuk wajib punya jurnal dan nomor dokumen';
  end if;
  if not exists (select 1 from ap_bill_goods_pools where transaction_id = new.transaction_id) then
    raise exception 'Tagihan % bukan tagihan barang (gak punya kolam)', new.transaction_id;
  end if;

  return new;
end;
$function$;

create or replace function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric
language sql stable
as $$
  select coalesce(sum(rl.qty_returned), 0)
  from return_lines rl
  join returns r on r.id = rl.return_id
  where r.transaction_id = p_bill_id and rl.type = 'OUTBOUND' and rl.item_id = p_item_id
    and return_is_active(r.id)
$$;

create or replace function sales_returned_qty(p_invoice_id uuid, p_item_id uuid) returns numeric
language sql stable
as $$
  select coalesce(sum(rl.qty_returned), 0)
  from return_lines rl
  join returns r on r.id = rl.return_id
  where r.transaction_id = p_invoice_id and rl.type = 'INBOUND' and rl.item_id = p_item_id
$$;

CREATE OR REPLACE FUNCTION public.cancel_ap_bill(p_bill_id uuid, p_entry_date date, p_source_ref text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
declare
  v_allocated_count int; v_return_count int;
  v_original_entry_id uuid; v_new_entry_id uuid; v_bill_ref text;
  v_has_pool boolean;
  v_order record; v_application record; v_adjustment record;
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

  select exists (select 1 from ap_bill_goods_pools where transaction_id = p_bill_id) into v_has_pool;

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
$function$;

CREATE OR REPLACE FUNCTION public.ap_bill_cancellation_preview(p_bill_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
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

  select count(*) into v_count from bill_pool_releases where transaction_id = p_bill_id;
  if v_count > 0 then
    v_blockers := v_blockers || 'Sisa barang sudah pernah ditutup, dan penutupan tidak bisa dibatalkan. Nilai yang salah dikoreksi lewat Koreksi Tagihan.';
  end if;

  for v_item in
    select l.item_id, i.name, sum(l.qty) as qty,
           sum(round(l.qty * l.unit_cost, 2) - coalesce(l.discount_amount, 0)) as net_value,
           coalesce(b.qty_on_hand, 0) as on_hand, coalesce(b.avg_cost, 0) as avg_cost
    from goods_notes gn
    join goods_note_lines l on l.goods_note_id = gn.id
    join items i on i.id = l.item_id
    left join inventory_balances b on b.item_id = l.item_id
    where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and goods_note_is_active(gn.id)
    group by l.item_id, i.name, b.qty_on_hand, b.avg_cost
  loop
    if v_item.on_hand < v_item.qty then
      v_blockers := v_blockers || format(
        'Stok "%s" tinggal %s, kurang dari %s yang diterima lewat tagihan ini karena sebagian sudah terjual. Perbaiki lewat Koreksi Barang Masuk dan Koreksi Tagihan.',
        v_item.name, trim_scale(v_item.on_hand), trim_scale(v_item.qty));
    elsif v_item.on_hand > v_item.qty and v_item.on_hand * v_item.avg_cost - v_item.net_value <= 0 then
      v_blockers := v_blockers || format(
        'Nilai stok "%s" tidak cukup untuk dibalik karena harganya sudah tercampur penjualan. Perbaiki lewat Koreksi Barang Masuk dan Koreksi Tagihan.',
        v_item.name);
    end if;
  end loop;

  return jsonb_build_object(
    'bill_ref', v_bill.source_ref,
    'amount', v_bill.amount,
    'goods_receipts', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'source_ref', o.source_ref, 'total_value', o.total_value) order by o.note_date)
      from goods_receipts_overview o
      where o.bill_id = p_bill_id and o.status = 'aktif'
    ), '[]'::jsonb),
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
$function$;

CREATE OR REPLACE FUNCTION public.cancel_ar_invoice(p_invoice_id uuid, p_entry_date date, p_source_ref text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
declare
  v_paid_count int; v_return_count int;
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
$function$;

CREATE OR REPLACE FUNCTION public.cancel_goods_receipt(p_goods_note_id uuid, p_entry_date date)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
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
      raise exception 'Barang masuk % gak bisa dibatalkan: item "%" sudah punya retur di tagihannya -- pakai Koreksi Barang Masuk',
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
$function$;

CREATE OR REPLACE FUNCTION public.recompute_transaction_status(p_transaction_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
          and goods_note_is_active(gn.id)
      ) then 'financial_only'
      when exists (
        select 1 from goods_notes gn
        where gn.transaction_id = p_transaction_id and gn.type = 'INBOUND'
          and goods_note_is_active(gn.id)
          and gn.order_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, status = v_status, origin = v_origin
      where id = p_transaction_id;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revise_goods_receipt(p_goods_note_id uuid, p_receipt_date date, p_delivery_note_ref text, p_lines jsonb, p_discount_amount numeric, p_reason text, p_entry_date date)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
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
        raise exception 'Koreksi ditolak: "%" sudah diretur %, sedangkan qty diterima setelah koreksi tinggal %',
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
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_default_accounts_base()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_default_account_settings_count int;
begin
  if not exists (
    select 1 from app_user_roles ur
    where ur.user_id = auth.uid() and ur.role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh menjalankan setup awal';
  end if;

  -- 1) Template COA -- persis daftar seed 0002_coa_schema.sql, idempotent by code.
  insert into accounts (code, name, category, is_contra) values
    ('1000', 'Kas', 'asset', false),
    ('1300', 'Piutang Usaha', 'asset', false),
    ('1350', 'Piutang Retur Supplier', 'asset', false),
    ('1360', 'Uang Muka Pembelian', 'asset', false),
    ('1400', 'Persediaan Bahan Baku', 'asset', false),
    ('1420', 'Persediaan Barang Jadi', 'asset', false),
    ('1500', 'PPN Masukan', 'asset', false),
    ('2100', 'Utang Usaha', 'liability', false),
    ('2200', 'Utang Bank', 'liability', false),
    ('2300', 'Uang Muka Penjualan', 'liability', false),
    ('2400', 'PPN Keluaran', 'liability', false),
    ('2500', 'Saldo Kredit Retur Customer', 'liability', false),
    ('3100', 'Modal Pemilik', 'equity', false),
    ('3200', 'Laba Ditahan', 'equity', false),
    ('4100', 'Pendapatan Penjualan Toko', 'revenue', false),
    ('4200', 'Pendapatan Penjualan Grosir', 'revenue', false),
    ('4300', 'Pendapatan Lain-lain', 'revenue', false),
    ('4400', 'Pendapatan Selisih Persediaan', 'revenue', false),
    ('4500', 'Pendapatan Selisih Pembulatan', 'revenue', false),
    ('4900', 'Retur & Potongan Penjualan', 'revenue', true),
    ('5100', 'Harga Pokok Penjualan', 'expense', false),
    ('5200', 'Beban Gaji Karyawan', 'expense', false),
    ('5300', 'Beban Sewa Toko', 'expense', false),
    ('5400', 'Beban Listrik dan Air', 'expense', false),
    ('5500', 'Beban Bunga Bank', 'expense', false),
    ('5700', 'Beban Piutang Tak Tertagih', 'expense', false),
    ('5800', 'Beban Kerugian Uang Muka', 'expense', false),
    ('5900', 'Beban Kerugian Barang Rusak', 'expense', false),
    ('6000', 'Beban Selisih Persediaan', 'expense', false),
    ('6100', 'Beban Biaya Pembelian', 'expense', false),
    ('6300', 'Beban Selisih Pembulatan', 'expense', false)
  on conflict (code) do nothing;

  -- Sengaja TIDAK termasuk akun Aset Tetap (dulu 1600/1610/1620/1630/1640/5600/5610/6200)
  -- -- modul Fixed Assets sudah dicabut total dari roadmap (keputusan owner 2026-09-15,
  -- lihat AGENTS.md), dan 2 dari akun itu ("Rak Display Toko"/"Mobil Pickup Antar Barang")
  -- malah bukan nama generik sama sekali -- nama aset fisik spesifik 1 bisnis tertentu,
  -- gak pantas jadi bagian template yang dipakai bisnis lain. Kalau bisnis butuh akun aset
  -- tetap, tambah manual lewat /accounts/new (kode auto-generate) + preset jurnal manual
  -- (docs/domain/general-ledger.md submodule "Preset Jurnal").
  insert into accounts (code, name, category, is_contra, parent_id)
    select v.code, v.name, v.category, v.is_contra, p.id
    from (values
      ('1100', 'Kas Toko', 'asset'::account_category, false, '1000'),
      ('1200', 'Kas di Bank', 'asset'::account_category, false, '1000')
    ) as v(code, name, category, is_contra, parent_code)
    join accounts p on p.code = v.parent_code
  on conflict (code) do nothing;

  -- 2) Daftar Jenis Dokumen -- normalnya udah keisi dari seed 0007_document_numbering_schema.sql
  -- (reference data, tetap di-seed migration -- beda dari accounts/app_default_account_settings/
  -- app_settings). Insert di sini idempotent (on conflict do nothing) -- cuma jaring pengaman
  -- kalau baris-barisnya ikut ditruncate pas seluruh data dihapus.
  insert into document_number_types (doc_type, prefix, label) values
    ('ap_bills', 'APB', 'AP Bill'),
    ('ap_payments', 'APP', 'AP Payment'),
    ('ap_credit_notes', 'APC', 'Retur AP — Kurangi Utang'),
    ('purchase_writeoffs', 'APW', 'Retur AP — Tulis-jadi-Beban'),
    ('ap_return_credit_refunds', 'APF', 'Refund Piutang Retur Supplier'),
    ('ap_deposits', 'APD', 'AP Deposit (DP ke Supplier)'),
    ('ap_deposit_applications', 'ADA', 'Penerapan DP AP'),
    ('ap_deposit_refunds', 'ADR', 'Refund DP AP'),
    ('ap_deposit_forfeitures', 'ADF', 'DP AP Hangus'),
    ('ar_invoices', 'ARI', 'AR Invoice'),
    ('ar_payments', 'ARP', 'AR Payment'),
    ('ar_credit_notes', 'ARC', 'Retur AR'),
    ('ar_return_credit_refunds', 'ARF', 'Refund Saldo Kredit Retur AR'),
    ('ar_deposits', 'ARD', 'AR Deposit (DP dari Customer)'),
    ('ar_deposit_applications', 'RDA', 'Penerapan DP AR'),
    ('ar_deposit_refunds', 'RDR', 'Refund DP AR'),
    ('ar_deposit_forfeitures', 'RDF', 'DP AR Hangus'),
    ('ar_bad_debt_writeoffs', 'ARW', 'Write-off Piutang Tak Tertagih'),
    ('purchase_orders', 'PO', 'Purchase Order'),
    ('sales_orders', 'SO', 'Sales Order'),
    ('goods_issues', 'GI', 'Goods Issue'),
    ('production_orders', 'PRD', 'Production Order'),
    ('stock_opnames', 'SOP', 'Stock Opname'),
    ('pos_sales', 'POS', 'POS Sale'),
    ('journal_entries', 'JE', 'Journal Entry (manual)'),
    ('period_closings', 'CLS', 'Tutup Buku'),
    ('item_unit_barcodes', 'SKU', 'Kode Scan Barang (item_units.barcode)')
  on conflict (doc_type) do nothing;

  -- 3) Default Akun -- persis seed 0008 (minus fixed_asset_account_presets, sudah dicabut
  -- 0030), idempotent by role_key. account_id di-resolve dari template yang baru diinsert
  -- di atas (atau yang sudah ada, kalau tabel accounts sebagian sudah keisi).
  -- Resolve by (code, name, category) sekaligus -- bukan cuma code -- biar kalau ternyata
  -- kode template kebetulan sudah dipakai akun LAIN yang gak terkait (nama/kategori beda),
  -- select-nya return 0 baris (assertion di bawah nangkep) daripada diam-diam nempel ke
  -- akun yang salah.
  insert into app_default_account_settings (role_key, label, account_id)
    select 'ar.receivable', 'Piutang Usaha', id from accounts where code = '1300' and name = 'Piutang Usaha' and category = 'asset'::account_category
  union all
    select 'ar.revenue', 'Pendapatan Penjualan Grosir', id from accounts where code = '4200' and name = 'Pendapatan Penjualan Grosir' and category = 'revenue'::account_category
  union all
    select 'ar.contra_revenue', 'Retur & Potongan Penjualan', id from accounts where code = '4900' and name = 'Retur & Potongan Penjualan' and category = 'revenue'::account_category
  union all
    select 'ar.deposit_liability', 'Uang Muka Penjualan', id from accounts where code = '2300' and name = 'Uang Muka Penjualan' and category = 'liability'::account_category
  union all
    select 'ar.writeoff_expense', 'Beban Piutang Tak Tertagih', id from accounts where code = '5700' and name = 'Beban Piutang Tak Tertagih' and category = 'expense'::account_category
  union all
    select 'ar.return_credit_liability', 'Saldo Kredit Retur Customer', id from accounts where code = '2500' and name = 'Saldo Kredit Retur Customer' and category = 'liability'::account_category
  union all
    select 'ar.other_revenue', 'Pendapatan Lain-lain', id from accounts where code = '4300' and name = 'Pendapatan Lain-lain' and category = 'revenue'::account_category
  union all
    select 'ap.payable', 'Utang Usaha', id from accounts where code = '2100' and name = 'Utang Usaha' and category = 'liability'::account_category
  union all
    select 'ap.return_credit_asset', 'Piutang Retur Supplier', id from accounts where code = '1350' and name = 'Piutang Retur Supplier' and category = 'asset'::account_category
  union all
    select 'ap.deposit_asset', 'Uang Muka Pembelian', id from accounts where code = '1360' and name = 'Uang Muka Pembelian' and category = 'asset'::account_category
  union all
    select 'ap.deposit_loss_expense', 'Beban Kerugian Uang Muka', id from accounts where code = '5800' and name = 'Beban Kerugian Uang Muka' and category = 'expense'::account_category
  union all
    select 'inventory.raw_material', 'Persediaan Bahan Baku', id from accounts where code = '1400' and name = 'Persediaan Bahan Baku' and category = 'asset'::account_category
  union all
    select 'inventory.finished_good', 'Persediaan Barang Jadi', id from accounts where code = '1420' and name = 'Persediaan Barang Jadi' and category = 'asset'::account_category
  union all
    select 'inventory.hpp', 'Harga Pokok Penjualan', id from accounts where code = '5100' and name = 'Harga Pokok Penjualan' and category = 'expense'::account_category
  union all
    select 'inventory.damage_loss_expense', 'Beban Kerugian Barang Rusak', id from accounts where code = '5900' and name = 'Beban Kerugian Barang Rusak' and category = 'expense'::account_category
  union all
    select 'inventory.shortage_expense', 'Beban Selisih Persediaan', id from accounts where code = '6000' and name = 'Beban Selisih Persediaan' and category = 'expense'::account_category
  union all
    select 'inventory.surplus_revenue', 'Pendapatan Selisih Persediaan', id from accounts where code = '4400' and name = 'Pendapatan Selisih Persediaan' and category = 'revenue'::account_category
  union all
    select 'cash.tunai', 'Kas Toko', id from accounts where code = '1100' and name = 'Kas Toko' and category = 'asset'::account_category
  union all
    select 'cash.bank', 'Kas di Bank', id from accounts where code = '1200' and name = 'Kas di Bank' and category = 'asset'::account_category
  union all
    select 'rounding.revenue', 'Pendapatan Selisih Pembulatan', id from accounts where code = '4500' and name = 'Pendapatan Selisih Pembulatan' and category = 'revenue'::account_category
  union all
    select 'rounding.expense', 'Beban Selisih Pembulatan', id from accounts where code = '6300' and name = 'Beban Selisih Pembulatan' and category = 'expense'::account_category
  on conflict (role_key) do nothing;

  -- Fail loud kalau ada role_key yang gagal ke-resolve (mis. kode template kebetulan sudah
  -- dipakai akun lain gak terkait) -- daripada diam-diam hilang dan baru meledak belakangan
  -- pas RPC lain (create_pos_sale, dst) butuh role_key ini di runtime.
  select count(*) into v_default_account_settings_count
    from app_default_account_settings
    where role_key in (
      'ar.receivable', 'ar.revenue', 'ar.contra_revenue', 'ar.deposit_liability',
      'ar.writeoff_expense', 'ar.return_credit_liability', 'ar.other_revenue',
      'ap.payable', 'ap.return_credit_asset', 'ap.deposit_asset', 'ap.deposit_loss_expense',
      'inventory.raw_material', 'inventory.finished_good', 'inventory.hpp',
      'inventory.damage_loss_expense', 'inventory.shortage_expense', 'inventory.surplus_revenue',
      'cash.tunai', 'cash.bank', 'rounding.revenue', 'rounding.expense'
    );
  if v_default_account_settings_count <> 21 then
    raise exception 'Bootstrap Default Akun gak lengkap (% dari 21 role_key ke-resolve) -- kemungkinan kode akun template sudah dipakai akun lain', v_default_account_settings_count;
  end if;
end;
$function$;

-- ============================================================================================
-- 2. View: inventory_movements_with_source tanpa tukar barang; goods_receipts_overview tanpa is_legacy
-- ============================================================================================

create or replace view inventory_movements_with_source
  with (security_invoker = true) as
SELECT im.id,
    im.item_id,
    im.movement_date,
    im.qty,
    im.created_at,
    COALESCE(
        CASE
            WHEN ((im.goods_note_line_id IS NOT NULL) AND (gn.type = 'INBOUND'::text)) THEN
            CASE
                WHEN (im.qty < (0)::numeric) THEN 'Pembatalan Barang Masuk'::text
                ELSE 'Pembelian (Terima Barang)'::text
            END
            ELSE NULL::text
        END,
        CASE
            WHEN ((im.goods_note_line_id IS NOT NULL) AND (gn.type = 'OUTBOUND'::text) AND (im.qty > (0)::numeric)) THEN 'Pembatalan Barang Keluar'::text
            ELSE NULL::text
        END,
        CASE
            WHEN (im.production_order_id IS NOT NULL) THEN 'Produksi (Hasil)'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((im.return_line_id IS NOT NULL) AND (rl.type = 'INBOUND'::text)) THEN 'Retur dari Customer'::text
            ELSE NULL::text
        END,
        CASE
            WHEN (im.stock_opname_line_id IS NOT NULL) THEN 'Penyesuaian Stock Opname'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((im.goods_note_line_id IS NOT NULL) AND (gn.type = 'OUTBOUND'::text)) THEN 'Penjualan (Kirim Barang)'::text
            ELSE NULL::text
        END,
        CASE
            WHEN (im.production_order_line_id IS NOT NULL) THEN 'Produksi (Konsumsi Bahan)'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((im.return_line_id IS NOT NULL) AND (rl.type = 'OUTBOUND'::text)) THEN
            CASE
                WHEN (im.qty > (0)::numeric) THEN 'Pembatalan Retur ke Supplier'::text
                ELSE 'Retur ke Supplier'::text
            END
            ELSE NULL::text
        END) AS source_label,
    COALESCE(ap_bill.source_ref, prod_header.source_ref, r.source_ref, so.source_ref, gn.source_ref, prod_line_header.source_ref) AS source_ref
   FROM ((((((((((inventory_movements im
     LEFT JOIN goods_note_lines gnl ON ((gnl.id = im.goods_note_line_id)))
     LEFT JOIN goods_notes gn ON ((gn.id = gnl.goods_note_id)))
     LEFT JOIN transactions ap_bill ON (((ap_bill.id = gn.transaction_id) AND (gn.type = 'INBOUND'::text))))
     LEFT JOIN production_orders prod_header ON ((prod_header.id = im.production_order_id)))
     LEFT JOIN return_lines rl ON ((rl.id = im.return_line_id)))
     LEFT JOIN returns r ON ((r.id = rl.return_id)))
     LEFT JOIN stock_opname_lines sol ON ((sol.id = im.stock_opname_line_id)))
     LEFT JOIN stock_opnames so ON ((so.id = sol.stock_opname_id)))
     LEFT JOIN production_order_lines pol ON ((pol.id = im.production_order_line_id)))
     LEFT JOIN production_orders prod_line_header ON ((prod_line_header.id = pol.production_order_id)));
-- goods_receipts_overview: kolom is_legacy dibuang (create or replace tidak bisa menghapus kolom) -> drop + create ulang,
-- opsi dan grant sama dengan 0059. Tidak ada view lain yang bergantung padanya.
drop view goods_receipts_overview;

create view goods_receipts_overview
  with (security_invoker = true) as
select
  gn.id,
  gn.counterparty_id,
  cp.name as supplier_name,
  gn.note_date,
  gn.source_ref,
  gn.delivery_note_ref,
  gn.order_id,
  o.source_ref as order_ref,
  gn.transaction_id as bill_id,
  bt.source_ref as bill_ref,
  bt.amount as bill_amount,
  case when c.goods_note_id is not null then 'dibatalkan' else 'aktif' end as status,
  coalesce(v.total_value, 0::numeric) as total_value,
  gn.created_at,
  gn.created_by
from goods_notes gn
left join counterparties cp on cp.id = gn.counterparty_id
left join orders o on o.id = gn.order_id
left join transactions bt on bt.id = gn.transaction_id
left join goods_note_cancellations c on c.goods_note_id = gn.id
left join lateral (
  select sum(round(l.qty * l.unit_cost, 2) - coalesce(l.discount_amount, 0::numeric)) as total_value
  from goods_note_lines l
  where l.goods_note_id = gn.id
) v on true
where gn.type = 'INBOUND';

grant select on goods_receipts_overview to authenticated;

-- ============================================================================================
-- 3. Buang fungsi, kolom, dan tabel yang tidak dipakai lagi
-- ============================================================================================

drop function revise_legacy_goods_receipt(uuid, jsonb, text, date);
drop function cancel_ap_replacement(uuid, date, text);

-- inventory_movements: kolom sumber tukar barang dibuang; CHECK "tepat 1 sumber" ditulis ulang tanpa kolom itu
-- (drop kolom ikut membuang FK komposit ke replacement_lines dan CHECK lama yang memuat kolomnya).
alter table inventory_movements drop constraint if exists inventory_movements_check;
alter table inventory_movements drop column replacement_line_id;
alter table inventory_movements add constraint inventory_movements_check
  check (num_nonnulls(goods_note_line_id, production_order_id, return_line_id, stock_opname_line_id, production_order_line_id) = 1);

drop function replacement_is_active(uuid);
drop table replacement_cancellations;
drop table replacement_lines;
drop table replacements;

alter table goods_note_cancellations alter column journal_entry_id set not null;

delete from document_number_types where doc_type in ('purchase_replacements', 'warranty_replacements');

commit;
