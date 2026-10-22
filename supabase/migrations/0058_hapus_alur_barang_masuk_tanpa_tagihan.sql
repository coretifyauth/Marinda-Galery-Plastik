-- 0058_hapus_alur_barang_masuk_tanpa_tagihan.sql
-- Pembersihan setelah 0057: membuang sisa alur "barang masuk tanpa tagihan" (0056) dari skema. Konsep:
-- docs/domain/accounts-payable.md "Tagihan Dulu, Barang Menyusul" dan docs/domain/inventory.md "Barang Masuk dari
-- Tagihan". Struktur data & jaminan data aman: docs/architecture/goods-notes-schema.md section "Barang Masuk dari
-- Tagihan" (tabel "Migrasi data lama dan jaminan data aman").
--
-- Yang dibuang: goods_note_billings, goods_note_billing_allocations, goods_note_revisions(+_lines), view
-- goods_notes_with_billing_status & goods_note_line_current_cost, fungsi grni_spill_allocation / inventory_add_billed /
-- trigger penghubung tagihan, kolom goods_notes.inbound_flow, kolom inventory_balances.qty_unbilled & spill_value,
-- dan peran Default Akun inventory.goods_received_not_invoiced.
--
-- NO DATA LOSS: semua isi yang dibuang disalin dulu ke skema `archive` (tidak diekspos ke API, RLS aktif tanpa
-- policy, hak akses dicabut dari anon/authenticated) dan jumlah barisnya diverifikasi sebelum drop. Akun 2150 dan
-- semua jurnal lama TIDAK disentuh. Satu transaksi: gagal di tengah = batal semua.
--
-- Klasifikasi barang masuk tanpa inbound_flow (kolom ini dibuang):
--   * lama (bundled): INBOUND dengan journal_entry_id NULL (jurnal Persediaan ada di jurnal tagihannya);
--   * baru: INBOUND dengan journal_entry_id terisi + transaction_id = tagihan barang;
--   * lama (deferred, dibatalkan): journal_entry_id terisi, transaction_id kosong -- selalu punya baris
--     goods_note_cancellations; hanya riwayat.

-- Supabase CLI menjalankan tiap statement TERPISAH (bukan satu transaksi per file) -- transaksi harus eksplisit supaya gagal di tengah = batal semua.
begin;

-- ============================================================================================
-- 0. Pagar awal -- gagal keras kalau data belum siap
-- ============================================================================================
do $$
begin
  if exists (
    select 1 from goods_notes gn
    where gn.type = 'INBOUND' and gn.inbound_flow = 'deferred'
      and not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
  ) then
    raise exception 'Masih ada barang masuk alur lama (tanpa tagihan) yang aktif -- tagih atau batalkan dulu sebelum menerapkan 0058';
  end if;

  if exists (select 1 from inventory_balances where qty_unbilled <> 0 or spill_value <> 0) then
    raise exception 'inventory_balances masih punya qty_unbilled/spill_value <> 0 -- gak boleh dibuang, bereskan dulu';
  end if;

  if exists (
    select 1 from goods_notes gn
    where gn.type = 'INBOUND' and gn.journal_entry_id is not null and gn.transaction_id is not null
      and not exists (select 1 from ap_bill_goods_pools p where p.transaction_id = gn.transaction_id)
  ) then
    raise exception 'Ada barang masuk berjurnal yang tagihannya bukan tagihan barang (tanpa kolam) -- data gak konsisten, periksa dulu';
  end if;

  -- Klasifikasi tanpa inbound_flow mengandalkan bentuk data lama ini; barang masuk alur lama bernilai 0 gak punya
  -- jurnal (0056 melewati jurnal kalau nilai 0) dan akan salah klasifikasi -- tolak dengan pesan jelas.
  if exists (
    select 1 from goods_notes
    where inbound_flow = 'bundled' and not (journal_entry_id is null and transaction_id is not null)
  ) then
    raise exception 'Ada barang masuk alur bundled yang bentuknya gak sesuai (harus tanpa jurnal dan punya tagihan) -- periksa dulu';
  end if;
  if exists (
    select 1 from goods_notes
    where inbound_flow = 'deferred'
      and not (journal_entry_id is not null and transaction_id is null and source_ref is not null)
  ) then
    raise exception 'Ada barang masuk alur deferred yang bentuknya gak sesuai (harus berjurnal, tanpa tagihan, bernomor) -- mis. barang masuk bernilai 0 tanpa jurnal; periksa dulu';
  end if;
end;
$$;

-- ============================================================================================
-- 1. Arsip (skema `archive`, gak diekspos ke API)
-- ============================================================================================
-- kunci tabel sumber: gak ada penulisan di antara salinan arsip dan drop (jalur tulis lama sudah ditutup 0057,
-- ini pengaman tambahan untuk aplikasi lama yang masih jalan saat deploy)
lock table goods_note_billings, goods_note_billing_allocations, goods_note_revisions, goods_note_revision_lines,
  goods_notes, app_default_account_settings in share row exclusive mode;

create schema if not exists archive;
revoke all on schema archive from public, anon, authenticated;

create table archive.goods_note_billings_0058 as select * from goods_note_billings;
create table archive.goods_note_billing_allocations_0058 as select * from goods_note_billing_allocations;
create table archive.goods_note_revisions_0058 as select * from goods_note_revisions;
create table archive.goods_note_revision_lines_0058 as select * from goods_note_revision_lines;
create table archive.goods_notes_inbound_flow_0058 as
  select id, type, inbound_flow, transaction_id, journal_entry_id, source_ref, note_date, counterparty_id
  from goods_notes where type = 'INBOUND';
create table archive.default_account_goods_received_not_invoiced_0058 as
  select * from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced';

alter table archive.goods_note_billings_0058 enable row level security;
alter table archive.goods_note_billing_allocations_0058 enable row level security;
alter table archive.goods_note_revisions_0058 enable row level security;
alter table archive.goods_note_revision_lines_0058 enable row level security;
alter table archive.goods_notes_inbound_flow_0058 enable row level security;
alter table archive.default_account_goods_received_not_invoiced_0058 enable row level security;
revoke all on all tables in schema archive from public, anon, authenticated;

-- arsip tahan ubah/hapus (pola tabel immutable proyek) dan punya PK supaya bisa dipulihkan kalau suatu hari perlu
alter table archive.goods_note_billings_0058 add primary key (id);
alter table archive.goods_note_billing_allocations_0058 add primary key (id);
alter table archive.goods_note_revisions_0058 add primary key (id);
alter table archive.goods_note_revision_lines_0058 add primary key (id);
alter table archive.goods_notes_inbound_flow_0058 add primary key (id);
alter table archive.default_account_goods_received_not_invoiced_0058 add primary key (id);

create trigger block_edit_delete before update or delete on archive.goods_note_billings_0058
  for each row execute function public.block_edit_delete();
create trigger block_edit_delete before update or delete on archive.goods_note_billing_allocations_0058
  for each row execute function public.block_edit_delete();
create trigger block_edit_delete before update or delete on archive.goods_note_revisions_0058
  for each row execute function public.block_edit_delete();
create trigger block_edit_delete before update or delete on archive.goods_note_revision_lines_0058
  for each row execute function public.block_edit_delete();
create trigger block_edit_delete before update or delete on archive.goods_notes_inbound_flow_0058
  for each row execute function public.block_edit_delete();
create trigger block_edit_delete before update or delete on archive.default_account_goods_received_not_invoiced_0058
  for each row execute function public.block_edit_delete();

-- Verifikasi arsip utuh SEBELUM apa pun dibuang.
do $$
begin
  if (select count(*) from archive.goods_note_billings_0058) <> (select count(*) from goods_note_billings)
     or (select count(*) from archive.goods_note_billing_allocations_0058) <> (select count(*) from goods_note_billing_allocations)
     or (select count(*) from archive.goods_note_revisions_0058) <> (select count(*) from goods_note_revisions)
     or (select count(*) from archive.goods_note_revision_lines_0058) <> (select count(*) from goods_note_revision_lines)
     or (select count(*) from archive.goods_notes_inbound_flow_0058) <> (select count(*) from goods_notes where type = 'INBOUND')
     or (select count(*) from archive.default_account_goods_received_not_invoiced_0058)
        <> (select count(*) from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced')
  then
    raise exception 'Arsip tidak utuh (jumlah baris beda dengan sumber) -- migration dibatalkan, belum ada yang dibuang';
  end if;

  -- isi baris harus identik dengan sumber (dua arah)
  if exists (select * from goods_note_billings except select * from archive.goods_note_billings_0058)
     or exists (select * from archive.goods_note_billings_0058 except select * from goods_note_billings)
     or exists (select * from goods_note_billing_allocations except select * from archive.goods_note_billing_allocations_0058)
     or exists (select * from archive.goods_note_billing_allocations_0058 except select * from goods_note_billing_allocations)
     or exists (select * from goods_note_revisions except select * from archive.goods_note_revisions_0058)
     or exists (select * from archive.goods_note_revisions_0058 except select * from goods_note_revisions)
     or exists (select * from goods_note_revision_lines except select * from archive.goods_note_revision_lines_0058)
     or exists (select * from archive.goods_note_revision_lines_0058 except select * from goods_note_revision_lines)
     or exists (
       select id, type, inbound_flow, transaction_id, journal_entry_id, source_ref, note_date, counterparty_id
         from goods_notes where type = 'INBOUND'
       except select * from archive.goods_notes_inbound_flow_0058)
     or exists (
       select * from archive.goods_notes_inbound_flow_0058
       except select id, type, inbound_flow, transaction_id, journal_entry_id, source_ref, note_date, counterparty_id
         from goods_notes where type = 'INBOUND')
     or exists (
       select * from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced'
       except select * from archive.default_account_goods_received_not_invoiced_0058)
     or exists (
       select * from archive.default_account_goods_received_not_invoiced_0058
       except select * from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced')
  then
    raise exception 'Isi arsip beda dengan sumber -- migration dibatalkan, belum ada yang dibuang';
  end if;

  -- setiap barang masuk lama alur bundled punya penghubung yang cocok dengan goods_notes.transaction_id
  if exists (
    select 1 from goods_note_billings b join goods_notes gn on gn.id = b.goods_note_id
    where gn.journal_entry_id is null and gn.transaction_id is distinct from b.transaction_id
  ) then
    raise exception 'goods_note_billings gak cocok dengan goods_notes.transaction_id -- migration dibatalkan';
  end if;
end;
$$;

-- ============================================================================================
-- 2. Fungsi stok bersama -- kembali ke rata-rata tertimbang biasa (tanpa qty_unbilled / spill_value)
-- ============================================================================================

-- consume_weighted_average -- satu-satunya jalur konsumsi stok. Menolak kalau stok kurang atau avg_cost = 0
-- (biaya pokok belum diketahui -- jurnal bernilai 0 gak valid).
create or replace function consume_weighted_average(p_item_id uuid, p_qty_needed numeric) returns numeric
language plpgsql
security invoker
as $$
declare
  v_qty_on_hand numeric;
  v_avg_cost numeric;
  v_item_name text;
begin
  select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
    from inventory_balances where item_id = p_item_id for update;

  if not found or v_qty_on_hand < p_qty_needed then
    select name into v_item_name from items where id = p_item_id;
    raise exception 'Stok Weighted Average item "%" gak cukup (tersedia %, butuh %)',
      coalesce(v_item_name, p_item_id::text), coalesce(v_qty_on_hand, 0), p_qty_needed;
  end if;

  if v_avg_cost = 0 then
    select name into v_item_name from items where id = p_item_id;
    raise exception 'Item "%" belum punya harga pokok (avg cost 0) -- gak bisa dijual/dikonsumsi sampai diberi harga lewat barang masuk', v_item_name;
  end if;

  update inventory_balances
    set qty_on_hand = v_qty_on_hand - p_qty_needed,
        updated_at = now()
    where item_id = p_item_id;

  return p_qty_needed * v_avg_cost;
end;
$$;

-- inventory_add_stock -- tambah stok pada biaya tertentu (barang masuk, hasil produksi, barang pengganti dari
-- supplier): avg_cost dicampur rata-rata tertimbang dengan stok yang ada. Menggantikan inventory_add_billed.
create function inventory_add_stock(p_item_id uuid, p_qty numeric, p_unit_cost numeric) returns void
language plpgsql
security invoker
as $$
declare
  v_qty_on_hand numeric;
  v_avg_cost numeric;
begin
  select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
    from inventory_balances where item_id = p_item_id for update;

  if not found then
    insert into inventory_balances (item_id, qty_on_hand, avg_cost) values (p_item_id, p_qty, p_unit_cost);
    return;
  end if;

  update inventory_balances
    set qty_on_hand = v_qty_on_hand + p_qty,
        avg_cost = (v_qty_on_hand * v_avg_cost + p_qty * p_unit_cost) / (v_qty_on_hand + p_qty),
        updated_at = now()
    where item_id = p_item_id;
end;
$$;

-- inventory_restore_stock -- stok KEMBALI (void/pembatalan penjualan, retur dari customer). Kalau p_unit_cost
-- diisi (retur dari customer), avg_cost dicampur dengan stok yang ada; kalau tidak, avg_cost gak berubah.
create or replace function inventory_restore_stock(p_item_id uuid, p_qty numeric, p_unit_cost numeric default null) returns void
language plpgsql
security invoker
as $$
declare
  v_qty_on_hand numeric;
  v_avg_cost numeric;
begin
  select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
    from inventory_balances where item_id = p_item_id for update;

  if not found then
    insert into inventory_balances (item_id, qty_on_hand, avg_cost) values (p_item_id, p_qty, coalesce(p_unit_cost, 0));
    return;
  end if;

  update inventory_balances
    set qty_on_hand = v_qty_on_hand + p_qty,
        avg_cost = case
          when p_unit_cost is not null and v_qty_on_hand + p_qty > 0
            then (v_qty_on_hand * v_avg_cost + p_qty * p_unit_cost) / (v_qty_on_hand + p_qty)
          else avg_cost end,
        updated_at = now()
    where item_id = p_item_id;
end;
$$;

-- ============================================================================================
-- 3. Fungsi yang tadinya membaca inbound_flow / qty_unbilled -- ditulis ulang tanpa keduanya
--    (isi sama dengan 0057 selain penggantian klasifikasi; diuji ulang di test-0058.sql)
-- ============================================================================================

-- Barang masuk berlaku: OUTBOUND & INBOUND lama (journal_entry_id NULL, jurnalnya di tagihan) mengikuti status
-- transaksi pasangannya; INBOUND berjurnal (alur baru, dan riwayat deferred) berlaku selama belum dibatalkan.
create or replace function goods_note_is_active(p_goods_note_id uuid) returns boolean
language sql stable
as $$
  select case
    when gn.type = 'INBOUND' and gn.journal_entry_id is not null
      then not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
    else coalesce(t.status, '') <> 'dibatalkan'
  end
  from goods_notes gn
  left join transactions t on t.id = gn.transaction_id
  where gn.id = p_goods_note_id
$$;

create or replace function ap_bill_pool_received_value(p_bill_id uuid) returns numeric
language sql stable
as $$
  select coalesce(sum(round(gnl.qty * gnl.unit_cost, 2) - coalesce(gnl.discount_amount, 0)), 0)
  from goods_notes gn
  join goods_note_lines gnl on gnl.goods_note_id = gn.id
  where gn.transaction_id = p_bill_id
    and gn.type = 'INBOUND'
    and gn.journal_entry_id is not null
    and not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
$$;

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
  if new.journal_entry_id is null or new.source_ref is null then
    raise exception 'Barang masuk wajib punya jurnal dan nomor dokumen';
  end if;

  select type, counterparty_id into v_bill_type, v_bill_supplier from transactions where id = new.transaction_id;
  if v_bill_type is distinct from 'INBOUND' then
    raise exception 'Transaksi % bukan tagihan AP', new.transaction_id;
  end if;
  if not exists (select 1 from ap_bill_goods_pools where transaction_id = new.transaction_id) then
    raise exception 'Tagihan % bukan tagihan barang (gak punya kolam)', new.transaction_id;
  end if;
  if v_bill_supplier is distinct from new.counterparty_id then
    raise exception 'Supplier barang masuk beda dengan supplier tagihan';
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function create_goods_receipt(
  p_bill_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- array of {"order_line_id":uuid|null,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric,"discount_amount":numeric (diskon item, opsional)}
  p_inventory_account_id uuid, -- akun Persediaan yang didebit
  p_order_id uuid default null,
  p_discount_amount numeric default 0 -- diskon header (di atas diskon item), diproratakan ke baris
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_bill transactions%rowtype;
  v_order_supplier uuid;
  v_pbd_account_id uuid;
  v_calc jsonb;
  v_discounts numeric[];
  v_idx int := 0;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_unit_cost numeric;
  v_line_discount numeric;
  v_line_value numeric;
  v_total_value numeric := 0;
  v_remaining numeric;
  v_source_ref text;
  v_entry_id uuid;
  v_note_id uuid;
  v_line_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || p_bill_id::text));

  select * into v_bill from transactions where id = p_bill_id and type = 'INBOUND';
  if not found then
    raise exception 'Tagihan % gak ditemukan', p_bill_id;
  end if;
  if v_bill.status = 'dibatalkan' then
    raise exception 'Tagihan % sudah dibatalkan -- gak bisa dibuat barang masuk', v_bill.source_ref;
  end if;
  if not exists (select 1 from ap_bill_goods_pools where transaction_id = p_bill_id) then
    raise exception 'Tagihan % bukan tagihan barang (gak punya kolam) -- barang masuk cuma bisa dibuat dari tagihan barang', v_bill.source_ref;
  end if;

  if p_order_id is not null then
    select counterparty_id into v_order_supplier from orders where id = p_order_id and direction = 'PURCHASE';
    if not found then
      raise exception 'Order % gak ditemukan atau bukan Purchase Order', p_order_id;
    end if;
    if exists (select 1 from orders where id = p_order_id and cancelled_at is not null) then
      raise exception 'Order % udah dibatalkan — gak bisa dibuat penerimaan barang', p_order_id;
    end if;
    if v_order_supplier is distinct from v_bill.counterparty_id then
      raise exception 'Supplier Purchase Order beda dengan supplier tagihan %', v_bill.source_ref;
    end if;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Barang masuk butuh minimal 1 baris item';
  end if;

  perform assert_period_open(p_receipt_date);

  -- Validasi input baris. Nilai jurnal, kolam, dan avg_cost dihitung dari angka yang SAMA dengan yang
  -- tersimpan (qty numeric(14,3), unit_cost numeric(14,2)) -- presisi lebih ditolak, bukan dibulatkan diam-diam.
  v_idx := 0;
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_idx := v_idx + 1;
    if v_line->>'item_id' is null or v_line->>'qty_received' is null or v_line->>'unit_cost' is null then
      raise exception 'Baris ke-% wajib punya item_id, qty_received, dan unit_cost', v_idx;
    end if;
    v_qty := (v_line->>'qty_received')::numeric;
    v_unit_cost := (v_line->>'unit_cost')::numeric;
    if v_qty <= 0 then
      raise exception 'Qty baris ke-% harus lebih dari 0', v_idx;
    end if;
    if v_qty <> round(v_qty, 3) then
      raise exception 'Qty baris ke-% maksimal 3 desimal', v_idx;
    end if;
    if v_unit_cost <= 0 then
      raise exception 'Harga baris ke-% harus lebih dari 0 -- barang masuk wajib berharga sesuai nota', v_idx;
    end if;
    if v_unit_cost <> round(v_unit_cost, 2) then
      raise exception 'Harga baris ke-% maksimal 2 desimal', v_idx;
    end if;
  end loop;
  if p_discount_amount is null or p_discount_amount < 0 or p_discount_amount <> round(p_discount_amount, 2) then
    raise exception 'Diskon header harus angka >= 0 dengan maksimal 2 desimal';
  end if;

  -- kunci baris stok berurutan item_id (hindari deadlock antar barang masuk yang urutan itemnya beda)
  perform 1 from inventory_balances
    where item_id in (select (t.value->>'item_id')::uuid from jsonb_array_elements(p_lines) as t(value))
    order by item_id for update;

  select account_id into v_pbd_account_id
    from app_default_account_settings where role_key = 'inventory.purchase_not_received';
  if v_pbd_account_id is null then
    raise exception 'Default Akun "Pembelian Belum Diterima" belum diset -- cek Pengaturan > Default Akun';
  end if;

  select jsonb_agg(
           jsonb_build_object(
             'qty', e->>'qty_received',
             'unit_cost', e->>'unit_cost',
             'discount_amount', coalesce(e->>'discount_amount', '0')
           ) order by ord)
    into v_calc
    from jsonb_array_elements(p_lines) with ordinality as t(e, ord);

  v_discounts := grn_prorate_discount(v_calc, p_discount_amount);

  v_idx := 0;
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_idx := v_idx + 1;
    if (v_line->>'unit_cost')::numeric <= 0 then
      raise exception 'Harga baris ke-% harus lebih dari 0 -- barang masuk wajib berharga sesuai nota', v_idx;
    end if;
    v_line_value := round((v_line->>'qty_received')::numeric * (v_line->>'unit_cost')::numeric, 2) - v_discounts[v_idx];
    if v_line_value <= 0 then
      raise exception 'Nilai bersih baris ke-% harus lebih dari 0 (setelah diskon)', v_idx;
    end if;
    v_total_value := v_total_value + v_line_value;
  end loop;

  v_remaining := ap_bill_pool_remaining(p_bill_id);
  if v_total_value > v_remaining then
    raise exception 'Nilai barang masuk % melebihi sisa kolam tagihan % (sisa %) -- sisanya harus ditagih lewat tagihan lain',
      v_total_value, v_bill.source_ref, v_remaining;
  end if;

  v_source_ref := generate_document_number('goods_receipts');

  v_entry_id := create_journal_entry(
    p_receipt_date, 'Barang masuk ' || v_source_ref, v_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', v_total_value, 'credit', 0),
      jsonb_build_object('account_id', v_pbd_account_id, 'debit', 0, 'credit', v_total_value)
    )
  );

  insert into goods_notes (type, order_id, transaction_id, delivery_note_ref, note_date, created_by,
                           counterparty_id, source_ref, journal_entry_id)
  values ('INBOUND', p_order_id, p_bill_id, p_delivery_note_ref, p_receipt_date, auth.uid(),
          v_bill.counterparty_id, v_source_ref, v_entry_id)
  returning id into v_note_id;

  v_idx := 0;
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_idx := v_idx + 1;
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_received')::numeric;
    v_unit_cost := (v_line->>'unit_cost')::numeric;
    v_line_discount := v_discounts[v_idx];

    insert into goods_note_lines (goods_note_id, order_line_id, item_id, qty, unit_cost, discount_amount)
    values (v_note_id, nullif(v_line->>'order_line_id', '')::uuid, v_item_id, v_qty, v_unit_cost, v_line_discount)
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_item_id, p_receipt_date, v_qty, v_line_id);

    -- avg_cost langsung dihitung dari biaya bersih baris (rata-rata tertimbang dengan stok yang ada)
    perform inventory_add_stock(
      v_item_id, v_qty, (round(v_qty * v_unit_cost, 2) - v_line_discount) / v_qty
    );
  end loop;

  return v_note_id;
end;
$$;

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
      raise exception 'Barang masuk % gak bisa dibatalkan: item "%" sudah punya retur/tukar barang di tagihannya',
        v_note.source_ref, v_item_name;
    end if;

    select qty_on_hand, avg_cost into v_qty_on_hand, v_avg_cost
      from inventory_balances where item_id = v_item.item_id for update;

    v_pool := coalesce(v_qty_on_hand, 0);
    if not found or v_pool < v_item.qty then
      raise exception 'Barang masuk % gak bisa dibatalkan: stok "%" tinggal %, kurang dari qty diterima % (sebagian sudah terpakai/terjual)',
        v_note.source_ref, v_item_name, v_pool, v_item.qty;
    end if;

    v_new_pool := v_pool - v_item.qty;
    v_new_value := v_pool * v_avg_cost - v_item.net_value;
    if v_new_pool > 0 and v_new_value <= 0 then
      raise exception 'Barang masuk % gak bisa dibatalkan: nilai persediaan "%" sisa gak cukup buat dibalik -- pakai Retur AP atau Stock Opname',
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

create or replace function cancel_ap_bill(
  p_bill_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_allocated_count int; v_return_count int; v_deposit_count int; v_replacement_count int;
  v_original_entry_id uuid; v_new_entry_id uuid; v_bill_ref text;
  v_has_bundled boolean; v_has_pool boolean;
  v_note record; v_line record; v_order record;
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

  select count(*) into v_allocated_count
  from payments where transaction_id = p_bill_id and type = 'INBOUND';

  if v_allocated_count > 0 then
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', v_bill_ref, v_allocated_count;
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
    select count(*) into v_deposit_count from deposit_applications where transaction_id = p_bill_id;
    select count(*) into v_replacement_count from replacements where transaction_id = p_bill_id;

    if v_deposit_count > 0 or v_replacement_count > 0 then
      raise exception 'Bill % (barang masuk) udah punya DP/tukar barang -- urus itu dulu sebelum dibatalkan', v_bill_ref;
    end if;

    if exists (select 1 from journal_entries je where je.reverses_entry_id = v_original_entry_id) then
      raise exception 'Bill % udah pernah dibatalkan', v_bill_ref;
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
      raise exception 'Bill % sudah punya pelepasan sisa kolam -- gak bisa dibatalkan lewat jalur ini', v_bill_ref;
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
        raise exception 'Barang masuk % gak bisa dibatalkan: stok "%" yang sudah ditagih tinggal %, kurang dari qty diterima % (sebagian sudah terpakai/terjual) -- pakai Retur AP atau Stock Opname',
          v_bill_ref, v_item_name, v_pool, v_line.qty;
      end if;

      v_net_value := v_line.qty * v_line.unit_cost - v_line.discount_amount;
      v_new_pool := v_pool - v_line.qty;
      v_new_value := v_pool * v_avg_cost - v_net_value;

      if v_new_pool > 0 and v_new_value <= 0 then
        raise exception 'Barang masuk % gak bisa dibatalkan: nilai persediaan "%" sisa gak cukup buat dibalik -- pakai Retur AP atau Stock Opname',
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

create or replace function create_production_order(
  p_bom_header_id uuid,
  p_qty_produced numeric,
  p_production_date date,
  p_source_ref text,
  p_finished_good_debit_account_id uuid,
  p_raw_material_credit_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_po_id uuid := gen_random_uuid();
  v_finished_item_id uuid;
  v_output_qty numeric;
  v_batch_multiplier numeric;
  v_bom_line record;
  v_qty_needed numeric;
  v_line_cost numeric;
  v_total_raw_cost numeric := 0;
  v_entry_id uuid;
  v_unit_cost numeric;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_line_id uuid;
begin
  select finished_item_id, output_qty into v_finished_item_id, v_output_qty
    from bom_headers where id = p_bom_header_id;

  v_batch_multiplier := p_qty_produced / v_output_qty;

  for v_bom_line in
    select bl.raw_material_item_id, bl.qty_per_batch
    from bom_lines bl
    where bl.bom_header_id = p_bom_header_id
  loop
    v_qty_needed := v_bom_line.qty_per_batch * v_batch_multiplier;

    v_line_cost := consume_weighted_average(v_bom_line.raw_material_item_id, v_qty_needed);

    v_line_items := array_append(v_line_items, v_bom_line.raw_material_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty_needed);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_raw_cost := v_total_raw_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_production_date, 'Produksi ' || p_qty_produced || ' unit', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_finished_good_debit_account_id, 'debit', v_total_raw_cost, 'credit', 0),
      jsonb_build_object('account_id', p_raw_material_credit_account_id, 'debit', 0, 'credit', v_total_raw_cost)
    )
  );

  insert into production_orders (id, bom_header_id, item_id, qty_produced, production_date, source_ref, journal_entry_id, created_by)
  values (v_po_id, p_bom_header_id, v_finished_item_id, p_qty_produced, p_production_date, p_source_ref, v_entry_id, auth.uid());

  insert into inventory_movements (item_id, movement_date, qty, production_order_id)
  values (v_finished_item_id, p_production_date, p_qty_produced, v_po_id);

  for i in 1..array_length(v_line_items, 1) loop
    insert into production_order_lines (production_order_id, item_id, qty_consumed, total_cost)
    values (v_po_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, production_order_line_id)
    values (v_line_items[i], p_production_date, -v_line_qtys[i], v_line_id);
  end loop;

  v_unit_cost := v_total_raw_cost / p_qty_produced;

  perform inventory_add_stock(v_finished_item_id, p_qty_produced, v_unit_cost);

  return v_po_id;
end;
$$;

create or replace function create_replacement(
  p_type text,
  p_transaction_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_debit_account_id uuid,
  p_credit_account_id uuid
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
  v_unit_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_line_id uuid;
begin
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Penggantian/penukaran barang butuh minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    if p_type = 'OUTBOUND' then
      v_unit_cost := v_line_cost / v_qty;
      perform inventory_add_stock(v_item_id, v_qty, v_unit_cost);
    end if;

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date,
    case when p_type = 'INBOUND' then 'Penukaran barang pasca-retur/garansi' else 'Tukar barang rusak dengan barang baik dari supplier' end,
    p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_debit_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_credit_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into replacements (id, type, transaction_id, replacement_date, source_ref, journal_entry_id, created_by)
  values (v_replacement_id, p_type, p_transaction_id, p_replacement_date, p_source_ref, v_entry_id, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into replacement_lines (replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
    returning id into v_line_id;

    -- barang keluar -- SELALU (barang pengganti ke customer, atau barang cacat ke supplier)
    insert into inventory_movements (item_id, movement_date, qty, replacement_line_id)
    values (v_line_items[i], p_replacement_date, -v_line_qtys[i], v_line_id);

    -- barang masuk -- CUMA OUTBOUND (barang baru dari supplier)
    if p_type = 'OUTBOUND' then
      insert into inventory_movements (item_id, movement_date, qty, replacement_line_id)
      values (v_line_items[i], p_replacement_date, v_line_qtys[i], v_line_id);
    end if;
  end loop;

  return v_replacement_id;
end;
$$;

create or replace function record_stock_opname(
  p_opname_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_actual":numeric,"inventory_account_id":uuid}
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

    select qty_on_hand, avg_cost into v_qty_system, v_avg_cost
      from inventory_balances where item_id = v_item_id for update;

    if not found then
      raise exception 'Item % gak punya inventory_balances', v_item_id;
    end if;

    v_variance := v_qty_actual - v_qty_system;

    if v_variance = 0 then
      continue;
    end if;

    if v_avg_cost = 0 then
      select name into v_item_name from items where id = v_item_id;
      raise exception 'Item "%" belum punya harga pokok -- opname ditolak, beri harga pokoknya dulu lewat barang masuk', v_item_name;
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

    if v_variance < 0 then
      perform consume_weighted_average(v_item_id, -v_variance);
    else
      update inventory_balances
        set qty_on_hand = v_qty_actual, updated_at = now()
        where item_id = v_item_id;
    end if;
  end loop;

  if not v_any_line then
    raise exception 'Gak ada selisih ditemukan di opname ini -- semua item cocok, gak perlu dicatat';
  end if;

  return v_opname_id;
end;
$$;

-- ============================================================================================
-- 4. Buang alur lama
-- ============================================================================================
drop view goods_notes_with_billing_status;
drop view goods_note_line_current_cost;

drop table goods_note_billing_allocations;
drop table goods_note_billings;
drop table goods_note_revision_lines;
drop table goods_note_revisions;

drop function goods_note_billings_guard();
drop function goods_note_billings_sync_status();
drop function grni_spill_allocation(uuid);
drop function inventory_add_billed(uuid, numeric, numeric);

alter table goods_notes drop column inbound_flow;
alter table inventory_balances drop column qty_unbilled, drop column spill_value;

-- jurnal Persediaan lama (bundled) gak punya nomor dokumen sendiri; selain itu keduanya terisi bersamaan
alter table goods_notes
  add constraint goods_notes_inbound_journal_source_pair
  check (type <> 'INBOUND' or (journal_entry_id is null) = (source_ref is null));

-- peran Default Akun lama (isinya sudah diarsipkan di atas); akun 2150 dan jurnalnya TIDAK dihapus
delete from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced';

commit;
