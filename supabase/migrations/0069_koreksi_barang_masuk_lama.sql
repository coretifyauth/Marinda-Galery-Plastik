-- 0069_koreksi_barang_masuk_lama.sql
-- Koreksi SATUAN/QTY barang masuk lama (dibuat bareng tagihannya, tanpa jurnal sendiri). Sebelumnya revise_goods_receipt
-- menolaknya. Syarat desain: tagihan dari supplier sudah benar, jadi NILAI tiap baris tetap dan hanya qty (dan harga per
-- satuan dasar, otomatis) yang berubah. Tidak ada jurnal Persediaan baru; jurnal hanya muncul untuk koreksi HPP kalau
-- sebagian barang sudah terjual.
--
-- Isi:
--   1. goods_note_is_active: barang masuk lama juga bisa "digantikan" (baris goods_note_cancellations tanpa jurnal).
--   1b. goods_notes_inbound_from_bill_guard: pengecualian sempit untuk dokumen pengganti hasil koreksi (tanpa ini insert-nya ditolak).
--   2. cancel_ap_bill: sama persis 0065 kecuali pembalikan stok tagihan lama melewati barang masuk yang sudah digantikan;
--      pesan penolakan menunjuk jalur koreksi baru.
--   3. ap_bill_cancellation_preview: sama persis 0065 kecuali teks petunjuk.
--   4. revise_legacy_goods_receipt: fungsi koreksi.
-- Supabase CLI menjalankan tiap statement TERPISAH -- dibungkus begin/commit supaya gagal di tengah = batal semua.

begin;

-- 1. goods_note_is_active
create or replace function goods_note_is_active(p_goods_note_id uuid) returns boolean
language sql stable
as $$
  -- 0069: barang masuk lama (tanpa jurnal sendiri) juga bisa digantikan koreksi (baris di goods_note_cancellations,
  -- journal_entry_id kosong); selain itu aktif selama tagihannya belum dibatalkan.
  select case
    when gn.type = 'INBOUND' and gn.journal_entry_id is not null
      then not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
    when gn.type = 'INBOUND'
      then not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
           and coalesce(t.status, '') <> 'dibatalkan'
    else coalesce(t.status, '') <> 'dibatalkan'
  end
  from goods_notes gn
  left join transactions t on t.id = gn.transaction_id
  where gn.id = p_goods_note_id
$$;

-- 1b. Penjaga barang masuk baru (goods_notes_inbound_from_bill_guard, 0058): salinan 0058 + SATU pengecualian sempit.
-- Barang masuk lama yang digantikan koreksi tetap berbentuk lama (tanpa jurnal & nomor, tagihan tanpa kolam). Pengecualian
-- hanya berlaku bila SEMUA terpenuhi: jurnal DAN nomor kosong, tagihan tidak punya kolam, dan tagihan itu sudah punya barang
-- masuk lama yang digantikan (baris goods_note_cancellations) -- fungsi koreksi membatalkan dokumen lama SEBELUM menyisipkan
-- penggantinya. Berbasis state (bukan flag sesi), jadi tidak bisa dipakai membuat barang masuk lama "dari nol".
create or replace function goods_notes_inbound_from_bill_guard() returns trigger as $$
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

  if new.journal_entry_id is null and new.source_ref is null then
    -- bentuk lama: hanya sebagai pengganti hasil koreksi
    if exists (select 1 from ap_bill_goods_pools where transaction_id = new.transaction_id)
       or not exists (
         select 1 from goods_notes old_gn
         join goods_note_cancellations c on c.goods_note_id = old_gn.id
         where old_gn.transaction_id = new.transaction_id and old_gn.type = 'INBOUND' and old_gn.journal_entry_id is null
       ) then
      raise exception 'Barang masuk wajib punya jurnal dan nomor dokumen';
    end if;
    return new;
  end if;

  if new.journal_entry_id is null or new.source_ref is null then
    raise exception 'Barang masuk wajib punya jurnal dan nomor dokumen';
  end if;
  if not exists (select 1 from ap_bill_goods_pools where transaction_id = new.transaction_id) then
    raise exception 'Tagihan % bukan tagihan barang (gak punya kolam)', new.transaction_id;
  end if;

  return new;
end;
$$ language plpgsql;

-- 2. cancel_ap_bill (salinan 0065 + 3 perubahan kecil)
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
    select count(*) into v_replacement_count from replacements
      where transaction_id = p_bill_id and replacement_is_active(id);

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
      and not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id) -- 0069: yang sudah digantikan koreksi dilewati
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
        raise exception 'Barang masuk % gak bisa dibatalkan: stok "%" tinggal %, kurang dari qty diterima % (sebagian sudah terpakai/terjual). Kalau qty atau satuannya salah, koreksi dulu lewat Koreksi Barang Masuk Lama',
          v_bill_ref, v_item_name, v_pool, v_line.qty;
      end if;

      v_net_value := v_line.qty * v_line.unit_cost - v_line.discount_amount;
      v_new_pool := v_pool - v_line.qty;
      v_new_value := v_pool * v_avg_cost - v_net_value;

      if v_new_pool > 0 and v_new_value <= 0 then
        raise exception 'Barang masuk % gak bisa dibatalkan: nilai persediaan "%" sisa gak cukup buat dibalik. Kalau qty atau satuannya salah, koreksi dulu lewat Koreksi Barang Masuk Lama',
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

-- 3. ap_bill_cancellation_preview (salinan 0065 + teks petunjuk)
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

  select count(*) into v_count from replacements where transaction_id = p_bill_id and replacement_is_active(id);
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
        case when v_item.is_legacy then 'Kalau qty atau satuannya salah, koreksi lewat Koreksi Barang Masuk Lama.'
             else 'Perbaiki lewat Koreksi Barang Masuk dan Koreksi Tagihan.' end);
    elsif v_item.on_hand > v_item.qty and v_item.on_hand * v_item.avg_cost - v_item.net_value <= 0 then
      v_blockers := v_blockers || format(
        'Nilai stok "%s" tidak cukup untuk dibalik karena harganya sudah tercampur penjualan. %s',
        v_item.name,
        case when v_item.is_legacy then 'Kalau qty atau satuannya salah, koreksi lewat Koreksi Barang Masuk Lama.'
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

-- 4. Koreksi barang masuk lama

-- revise_legacy_goods_receipt -- koreksi SATUAN/QTY barang masuk lama. Tagihan sudah benar, jadi NILAI tiap baris tetap persis;
-- hanya qty berubah, harga per satuan dasar dihitung ulang (dibulatkan ke atas, sisa sen ditampung di diskon baris, sama
-- seperti layar barang masuk baru). Dokumen lama dibatalkan TANPA jurnal (jurnal Persediaan-nya ada di tagihan, dan tagihan
-- tidak berubah) dan digantikan dokumen baru dengan tagihan yang sama.
--
-- Stok & HPP memakai rumus yang sama dengan revise_goods_receipt (0060): nilai baris tetap, jadi selisih nilai = 0 dan
-- seluruh perubahan ada di "selisih harga" -- porsi yang masih di stok tetap, porsi yang sudah terjual dikoreksi ke HPP
-- (Debit Persediaan / Kredit HPP, atau sebaliknya) pada tanggal p_entry_date.
create function revise_legacy_goods_receipt(
  p_goods_note_id uuid,
  p_lines jsonb, -- [{"line_id": uuid, "qty": numeric}] -- tepat satu entri per baris barang masuk lama
  p_reason text,
  p_entry_date date
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_note goods_notes%rowtype;
  v_bill_ref text;
  v_new_note_id uuid;
  v_before jsonb := '{}'::jsonb;
  v_snapshot jsonb;
  v_item record;
  v_line record;
  v_old_count int;
  v_old_net numeric;
  v_unit_cost numeric;
  v_gross numeric;
  v_new_line_id uuid;
  v_changed boolean := false;
  v_on_hand numeric; v_avg numeric; v_share numeric;
  v_q0 numeric; v_v0 numeric; v_q1 numeric; v_v1 numeric;
  v_value numeric; v_new_qty numeric; v_new_value numeric; v_delta numeric; v_price_part numeric; v_stock_part numeric;
  v_unit numeric;
  v_item_name text;
  v_item_account_id uuid;
  v_item_cogs numeric;
  v_cogs numeric := 0;
  v_journal_lines jsonb := '[]'::jsonb;
  v_hpp_account_id uuid;
  v_cogs_entry_id uuid;
  v_claimed numeric;
  v_active_qty numeric;
begin
  select * into v_note from goods_notes where id = p_goods_note_id and type = 'INBOUND';
  if not found then
    raise exception 'Barang masuk % gak ditemukan', p_goods_note_id;
  end if;
  if v_note.journal_entry_id is not null or v_note.transaction_id is null then
    raise exception 'Ini bukan barang masuk lama -- pakai Koreksi Barang Masuk biasa';
  end if;

  -- urutan lock sama dengan cancel_ap_bill: cancel_transaction -> (dokumen) -> pool
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || v_note.transaction_id::text));
  perform pg_advisory_xact_lock(hashtext('goods_receipt:' || p_goods_note_id::text));
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || v_note.transaction_id::text));

  if not goods_note_is_active(p_goods_note_id) then
    raise exception 'Barang masuk ini sudah dikoreksi/dibatalkan, atau tagihannya sudah dibatalkan';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Alasan koreksi wajib diisi';
  end if;
  if p_entry_date < v_note.note_date then
    raise exception 'Tanggal koreksi % lebih awal dari tanggal barang masuk %', p_entry_date, v_note.note_date;
  end if;
  perform assert_period_open(p_entry_date);

  select source_ref into v_bill_ref from transactions where id = v_note.transaction_id;
  select count(*) into v_old_count from goods_note_lines where goods_note_id = p_goods_note_id;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) <> v_old_count then
    raise exception 'Koreksi harus mencantumkan semua % baris barang masuk ini, masing-masing satu kali', v_old_count;
  end if;
  if (select count(distinct t.value->>'line_id') from jsonb_array_elements(p_lines) as t(value)) <> v_old_count
     or exists (
       select 1 from jsonb_array_elements(p_lines) as t(value)
       where not exists (
         select 1 from goods_note_lines l where l.id = (t.value->>'line_id')::uuid and l.goods_note_id = p_goods_note_id)) then
    raise exception 'Daftar baris koreksi tidak cocok dengan baris barang masuk ini';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) as t(value)
    where coalesce((t.value->>'qty')::numeric, 0) <= 0 or round((t.value->>'qty')::numeric, 3) <> (t.value->>'qty')::numeric
  ) then
    raise exception 'Qty tiap baris harus lebih dari 0 dan maksimal 3 desimal';
  end if;
  if not exists (
    select 1 from goods_note_lines l join jsonb_array_elements(p_lines) as t(value) on (t.value->>'line_id')::uuid = l.id
    where l.goods_note_id = p_goods_note_id and l.qty <> (t.value->>'qty')::numeric
  ) then
    raise exception 'Tidak ada perubahan qty -- tidak ada yang perlu dikoreksi';
  end if;

  -- foto stok SEBELUM apa pun diubah (kunci berurutan item_id, hindari deadlock)
  for v_item in
    select distinct item_id from goods_note_lines where goods_note_id = p_goods_note_id order by item_id
  loop
    select qty_on_hand, avg_cost into v_on_hand, v_avg from inventory_balances where item_id = v_item.item_id for update;
    v_on_hand := coalesce(v_on_hand, 0);
    v_avg := coalesce(v_avg, 0);
    v_before := v_before || jsonb_build_object(v_item.item_id::text, jsonb_build_object(
      'q', v_on_hand, 'a', v_avg, 's', goods_receipt_stock_share(p_goods_note_id, v_item.item_id, v_on_hand)));
  end loop;

  -- batalkan dokumen lama TANPA jurnal dan TANPA sentuh saldo stok (saldo final ditulis di bawah dari foto di atas)
  for v_line in select id, item_id, qty from goods_note_lines where goods_note_id = p_goods_note_id
  loop
    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line.item_id, p_entry_date, -v_line.qty, v_line.id);
  end loop;
  insert into goods_note_cancellations (goods_note_id, journal_entry_id, cancelled_by)
  values (p_goods_note_id, null, auth.uid());

  -- dokumen pengganti: tetap "lama" (tanpa jurnal & nomor sendiri), tagihan/PO/supplier/tanggal sama
  insert into goods_notes (type, order_id, transaction_id, delivery_note_ref, note_date, created_by,
                           counterparty_id, source_ref, journal_entry_id)
  values ('INBOUND', v_note.order_id, v_note.transaction_id, v_note.delivery_note_ref, v_note.note_date, auth.uid(),
          v_note.counterparty_id, null, null)
  returning id into v_new_note_id;

  for v_line in
    select l.id, l.item_id, l.order_line_id, l.qty, l.unit_cost, coalesce(l.discount_amount, 0) as discount_amount,
           (t.value->>'qty')::numeric as new_qty
    from goods_note_lines l join jsonb_array_elements(p_lines) as t(value) on (t.value->>'line_id')::uuid = l.id
    where l.goods_note_id = p_goods_note_id
    order by l.id
  loop
    v_old_net := round(v_line.qty * v_line.unit_cost, 2) - v_line.discount_amount;
    if v_old_net <= 0 then
      raise exception 'Nilai baris barang masuk lama tidak valid (%) -- hubungi admin', v_old_net;
    end if;
    -- harga satuan dasar baru dibulatkan KE ATAS supaya nilai kotor >= nilai lama; selisihnya (< 1 sen x qty) jadi diskon
    -- baris, sehingga round(qty x harga, 2) - diskon = nilai lama persis.
    v_unit_cost := greatest(ceil(v_old_net / v_line.new_qty * 100) / 100, 0.01);
    v_gross := round(v_line.new_qty * v_unit_cost, 2);

    insert into goods_note_lines (goods_note_id, order_line_id, item_id, qty, unit_cost, discount_amount)
    values (v_new_note_id, v_line.order_line_id, v_line.item_id, v_line.new_qty, v_unit_cost, v_gross - v_old_net)
    returning id into v_new_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line.item_id, p_entry_date, v_line.new_qty, v_new_line_id);
  end loop;

  -- saldo final per item (rumus revise_goods_receipt; nilai baris tetap => selisih nilai 0)
  for v_item in
    select distinct item_id from goods_note_lines where goods_note_id = p_goods_note_id order by item_id
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
      v_unit := case when v_q1 > 0 then v_v1 / v_q1 else v_avg end;
      v_new_value := v_new_qty * v_unit;
    end if;

    v_item_cogs := round(v_delta - (v_new_value - v_value), 2);
    if v_item_cogs <> 0 then
      -- akun Persediaan item (tagihan lama tidak punya jurnal barang masuk sendiri untuk dirujuk, beda dari revise_goods_receipt);
      -- sejak 0064 semua barang memakai satu akun Persediaan, jadi sama dengan akun yang didebit tagihan lama.
      select inventory_account_id into v_item_account_id from items where id = v_item.item_id;
      v_journal_lines := v_journal_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_item_account_id,
        'debit', case when v_item_cogs < 0 then -v_item_cogs else 0 end,
        'credit', case when v_item_cogs > 0 then v_item_cogs else 0 end));
      v_cogs := v_cogs + v_item_cogs;
    end if;

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
    select account_id into v_hpp_account_id from app_default_account_settings where role_key = 'inventory.hpp';
    if v_hpp_account_id is null then
      raise exception 'Default Akun "inventory.hpp" belum diset -- cek Pengaturan > Default Akun';
    end if;
    v_journal_lines := v_journal_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_hpp_account_id,
      'debit', case when v_cogs > 0 then v_cogs else 0 end,
      'credit', case when v_cogs < 0 then -v_cogs else 0 end));
    v_cogs_entry_id := create_journal_entry(
      p_entry_date, 'Koreksi HPP dari koreksi barang masuk lama ' || v_bill_ref, v_bill_ref || '/KOR', v_journal_lines);
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

grant execute on function revise_legacy_goods_receipt(uuid, jsonb, text, date) to authenticated;

commit;
