-- 0065 Batalkan tukar barang (hanya data lama).
-- Fitur Tukar Barang dicabut di 0063; satu baris uji OUTBOUND (APX-2026-00001) masih menghitung klaim qty di
-- purchase_returned_qty (menghalangi Koreksi Barang Masuk) dan menghalangi cancel_ap_bill. 0063 menyerahkan pembereskannya
-- ke keputusan terpisah: ini jalurnya -- tabel penanda replacement_cancellations (append-only, pola return_cancellations)
-- dan cancel_ap_replacement, TANPA UI baru (fiturnya sudah tidak ada). Panggil dari SQL Editor oleh admin:
--   select cancel_ap_replacement((select id from replacements where source_ref = 'APX-2026-00001'), current_date, 'Data uji, fitur dicabut');
-- Hanya tukar barang ke supplier (OUTBOUND). Sisi customer (INBOUND) tidak punya baris dan tetap tidak berubah.
--
-- Efek stok: tukar barang OUTBOUND selalu 2 mutasi (barang cacat keluar, barang pengganti masuk) pada biaya rata-rata yang
-- sama, jadi saldo stok dan nilainya netto tidak berubah; pembatalan karena itu juga tidak menyentuh inventory_balances dan
-- tidak menambah mutasi. Jurnalnya netto nol HANYA kalau pemanggil lama mengirim akun yang sama di debit dan kredit (UI lama
-- begitu, tapi RPC tidak memaksa) -- verifikasi jurnal baris yang dibatalkan sebelum menjalankan. Apa pun isinya, jurnal
-- dibalik lewat reverse_journal_entry sehingga tetap seimbang.

-- Supabase CLI menjalankan tiap statement TERPISAH (bukan satu transaksi per file) -- transaksi harus eksplisit supaya gagal di tengah = batal semua.
begin;

create table replacement_cancellations (
  replacement_id uuid primary key references replacements(id),
  journal_entry_id uuid not null references journal_entries(id),
  reason text not null check (length(trim(reason)) > 0),
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz not null default now()
);

create trigger replacement_cancellations_block_edit_delete
  before update or delete on replacement_cancellations
  for each row execute function block_edit_delete();

alter table replacement_cancellations enable row level security;

create policy replacement_cancellations_select on replacement_cancellations
  for select using (auth.role() = 'authenticated');

create policy replacement_cancellations_insert on replacement_cancellations
  for insert with check (
    exists (select 1 from app_user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant select, insert on replacement_cancellations to authenticated;

create function replacement_is_active(p_replacement_id uuid) returns boolean
language sql stable
as $$
  select not exists (select 1 from replacement_cancellations c where c.replacement_id = p_replacement_id)
$$;

-- purchase_returned_qty -- sama persis 0061 kecuali tukar barang yang dibatalkan tidak dihitung.
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
        and replacement_is_active(rp.id)
    ), 0)
  into v_result;
  return v_result;
end;
$$ language plpgsql stable;

-- cancel_ap_replacement -- membalik jurnal tukar barang dan menandainya dibatalkan.
create function cancel_ap_replacement(
  p_replacement_id uuid,
  p_entry_date date,
  p_reason text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_replacement replacements%rowtype;
  v_bill transactions%rowtype;
  v_reversal_id uuid;
begin
  select * into v_replacement from replacements where id = p_replacement_id and type = 'OUTBOUND';
  if not found then
    raise exception 'Tukar barang % gak ditemukan', p_replacement_id;
  end if;

  -- urutan lock sama dengan cancel_ap_bill / cancel_ap_return: cancel_transaction -> kolam
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || v_replacement.transaction_id::text));
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || v_replacement.transaction_id::text));

  if not replacement_is_active(p_replacement_id) then
    raise exception 'Tukar barang % sudah dibatalkan', v_replacement.source_ref;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Alasan pembatalan tukar barang wajib diisi';
  end if;

  select * into v_bill from transactions where id = v_replacement.transaction_id;
  if v_bill.status = 'dibatalkan' then
    raise exception 'Tagihan % sudah dibatalkan', v_bill.source_ref;
  end if;

  if p_entry_date < v_replacement.replacement_date then
    raise exception 'Tanggal pembatalan % lebih awal dari tanggal tukar barang %', p_entry_date, v_replacement.replacement_date;
  end if;
  perform assert_period_open(p_entry_date);

  v_reversal_id := reverse_journal_entry(v_replacement.journal_entry_id, p_entry_date, v_replacement.source_ref || '/BTL');

  insert into replacement_cancellations (replacement_id, journal_entry_id, reason, cancelled_by)
  values (p_replacement_id, v_reversal_id, trim(p_reason), auth.uid());

  return v_reversal_id;
end;
$$;

grant execute on function cancel_ap_replacement(uuid, date, text) to authenticated;

-- cancel_ap_bill -- sama persis 0061 kecuali penghitung tukar barang hanya yang aktif.
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

-- ap_bill_cancellation_preview -- sama persis 0061 kecuali penghalang tukar barang hanya untuk yang aktif.
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

commit;
