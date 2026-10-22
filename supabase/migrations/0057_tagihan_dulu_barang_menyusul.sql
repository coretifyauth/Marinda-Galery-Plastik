-- 0057_tagihan_dulu_barang_menyusul.sql
-- Tagihan Dulu, Barang Menyusul (kolam tagihan). Konsep: docs/domain/accounts-payable.md submodule
-- "Tagihan Dulu, Barang Menyusul (Kolam Tagihan)" dan docs/domain/inventory.md submodule "Barang Masuk
-- dari Tagihan". Struktur data & jaminan data aman: docs/architecture/goods-notes-schema.md section
-- "Barang Masuk dari Tagihan (Tagihan Dulu, Barang Menyusul)".
--
-- Ringkasan:
--   * Barang masuk (goods_notes INBOUND) SELALU dibuat dari tepat 1 tagihan barang (goods_notes.transaction_id).
--     Barang masuk tanpa tagihan (alur 'deferred' dari 0056) dihapus.
--   * Tagihan barang punya "kolam" = bagian barang dari tagihan (ap_bill_goods_pools). Jurnal tagihan:
--     Debit Pembelian Belum Diterima (aset 1370) / Kredit Utang Usaha. Jurnal barang masuk:
--     Debit Persediaan / Kredit Pembelian Belum Diterima. Alokasi gak berjurnal.
--   * Sisa kolam dilepas lewat release_ap_bill_pool: receh -> Selisih Pembulatan, yang sudah dibayar -> Uang Muka.
--   * avg_cost langsung dihitung saat barang masuk (inventory_add_billed) -- stok "belum ditagih" gak dipakai
--     lagi (kolom qty_unbilled/spill_value tetap ada tapi selalu 0; dibuang di 0058).
--
-- Prinsip keamanan data: migration ini HANYA MENAMBAH dan mengganti fungsi -- gak ada tabel/kolom/baris yang
-- dihapus (itu tugas 0058, setelah 0057 terbukti jalan). Satu transaksi: gagal di tengah = batal semua.
-- Deploy harus SERENTAK dengan aplikasi baru: create_goods_receipt lama (7 argumen, 0056) di-drop.

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
    raise exception 'Masih ada barang masuk alur lama (tanpa tagihan / belum dibatalkan) -- tagih atau batalkan dulu sebelum menerapkan 0057';
  end if;

  if exists (select 1 from inventory_balances where qty_unbilled > 0 or spill_value > 0) then
    raise exception 'Masih ada stok "belum ditagih" (qty_unbilled/spill_value > 0) di inventory_balances -- bereskan dulu sebelum menerapkan 0057';
  end if;
end;
$$;

-- ============================================================================================
-- 1. Tabel baru (append-only)
-- ============================================================================================

-- 1a. Kolam tagihan: 1 baris per tagihan barang. amount = bagian barang (di luar biaya tambahan/PPN).
create table ap_bill_goods_pools (
  transaction_id uuid primary key references transactions(id),
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

comment on table ap_bill_goods_pools is 'Kolam tagihan barang: nilai bagian barang tagihan AP yang menunggu barang masuk. Sisa kolam = amount - nilai bersih barang masuk aktif - pelepasan (view ap_bill_goods_pool_status).';

-- 1b. Pelepasan sisa kolam (barang gak jadi datang / receh).
create table bill_pool_releases (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references ap_bill_goods_pools(transaction_id),
  kind text not null check (kind in ('pembulatan', 'uang_muka')),
  amount numeric(14,2) not null check (amount > 0),
  release_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  deposit_id uuid references deposits(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint bill_pool_releases_deposit_only_uang_muka check ((kind = 'uang_muka') = (deposit_id is not null))
);

create index bill_pool_releases_transaction_id_idx on bill_pool_releases(transaction_id);
create index bill_pool_releases_journal_entry_id_idx on bill_pool_releases(journal_entry_id);

comment on table bill_pool_releases is 'Pelepasan sisa kolam tagihan: pembulatan (sisa < satuan pembulatan -> Beban Selisih Pembulatan) atau uang_muka (bagian yang sudah dibayar -> deposits INBOUND).';

create trigger ap_bill_goods_pools_block_edit_delete before update or delete on ap_bill_goods_pools
  for each row execute function block_edit_delete();
create trigger bill_pool_releases_block_edit_delete before update or delete on bill_pool_releases
  for each row execute function block_edit_delete();

alter table ap_bill_goods_pools enable row level security;
alter table bill_pool_releases enable row level security;

create policy ap_bill_goods_pools_select on ap_bill_goods_pools for select using (auth.role() = 'authenticated');
create policy bill_pool_releases_select on bill_pool_releases for select using (auth.role() = 'authenticated');
create policy ap_bill_goods_pools_insert on ap_bill_goods_pools for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin'));
create policy bill_pool_releases_insert on bill_pool_releases for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin'));

grant select, insert on ap_bill_goods_pools to authenticated;
grant select, insert on bill_pool_releases to authenticated;

-- ============================================================================================
-- 2. Akun Pembelian Belum Diterima (aset) + Default Akun
-- ============================================================================================

-- DB yang SUDAH lewat onboarding (app_settings ada): akun + peran dibuat di sini (pola 0054/0056).
-- DB yang belum di-setup dilewati -- template onboarding (bootstrap_default_accounts di bawah) yang mengisinya.
do $$
declare
  v_count int;
begin
  if not exists (select 1 from app_settings) then
    return;
  end if;

  insert into accounts (code, name, category, is_contra) values
    ('1370', 'Pembelian Belum Diterima', 'asset', false)
  on conflict (code) do nothing;

  insert into app_default_account_settings (role_key, label, account_id)
    select 'inventory.purchase_not_received', 'Pembelian Belum Diterima', id
    from accounts
    where code = '1370' and name = 'Pembelian Belum Diterima' and category = 'asset'::account_category
  on conflict (role_key) do nothing;

  select count(*) into v_count
    from app_default_account_settings where role_key = 'inventory.purchase_not_received';
  if v_count <> 1 then
    raise exception 'Default Akun Pembelian Belum Diterima gagal di-resolve -- kode akun 1370 kemungkinan sudah dipakai akun lain';
  end if;
end;
$$;

-- bootstrap_default_accounts -- template onboarding: akun 1370 + peran baru menggantikan 2150/peran lama
-- (0056). Memanggil _base (template 0054 yang 21 peran) lalu menambah akun baru (idempotent).
create or replace function bootstrap_default_accounts() returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  perform bootstrap_default_accounts_base();

  -- jaring pengaman jenis dokumen (kalau barisnya ikut ditruncate pas seluruh data dihapus)
  insert into document_number_types (doc_type, prefix, label) values ('goods_receipts', 'GRN', 'Barang Masuk')
  on conflict (doc_type) do nothing;

  insert into accounts (code, name, category, is_contra) values
    ('1370', 'Pembelian Belum Diterima', 'asset', false)
  on conflict (code) do nothing;

  insert into app_default_account_settings (role_key, label, account_id)
    select 'inventory.purchase_not_received', 'Pembelian Belum Diterima', id
    from accounts
    where code = '1370' and name = 'Pembelian Belum Diterima' and category = 'asset'::account_category
  on conflict (role_key) do nothing;

  select count(*) into v_count
    from app_default_account_settings where role_key = 'inventory.purchase_not_received';
  if v_count <> 1 then
    raise exception 'Bootstrap Default Akun Pembelian Belum Diterima gagal -- kode akun 1370 kemungkinan sudah dipakai akun lain';
  end if;
end;
$$;

grant execute on function bootstrap_default_accounts() to authenticated;

-- ============================================================================================
-- 3. goods_notes: pagar barang masuk wajib dari tagihan barang
-- ============================================================================================

-- Barang masuk alur baru: inbound_flow NULL, transaction_id = tagihan barang, journal_entry_id & source_ref
-- terisi. inbound_flow tetap berisi 'bundled' / 'deferred' hanya untuk baris lama (kolom dibuang di 0058).
alter table goods_notes drop constraint goods_notes_inbound_flow_set;
-- pagar OUTBOUND yang tadinya ikut dijaga constraint di atas: inbound_flow hanya boleh terisi di baris INBOUND
alter table goods_notes add constraint goods_notes_inbound_flow_only_inbound check (type = 'INBOUND' or inbound_flow is null);

create function goods_notes_inbound_from_bill_guard() returns trigger as $$
declare
  v_bill_type text;
  v_bill_supplier uuid;
begin
  if new.type <> 'INBOUND' then
    return new;
  end if;

  if new.inbound_flow is not null then
    raise exception 'Barang masuk tanpa tagihan (alur "%") sudah dihapus -- barang masuk wajib dibuat dari tagihan barang', new.inbound_flow;
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

create trigger goods_notes_inbound_from_bill_guard_trigger
  before insert on goods_notes
  for each row execute function goods_notes_inbound_from_bill_guard();

-- Harga baris barang masuk baru wajib > 0 (0056 melonggarkannya jadi >= 0 untuk "harga belum tahu").
-- NOT VALID: baris lama (termasuk barang masuk alur lama yang sudah dibatalkan) gak divalidasi ulang.
alter table goods_note_lines
  add constraint goods_note_lines_inbound_cost_positive check (unit_cost is null or unit_cost > 0) not valid;

-- Barang masuk "berlaku": OUTBOUND & INBOUND lama (bundled) mengikuti status transaksi pasangannya;
-- INBOUND alur baru (inbound_flow NULL) dan deferred berlaku selama belum dibatalkan sebagai barang masuk
-- (pembatalan TAGIHAN barang ditolak selama masih ada barang masuk aktif).
create or replace function goods_note_is_active(p_goods_note_id uuid) returns boolean
language sql stable
as $$
  select case
    when gn.type = 'INBOUND' and gn.inbound_flow is distinct from 'bundled'
      then not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
    else coalesce(t.status, '') <> 'dibatalkan'
  end
  from goods_notes gn
  left join transactions t on t.id = gn.transaction_id
  where gn.id = p_goods_note_id
$$;

-- ============================================================================================
-- 4. Fungsi bantu baca + view sisa kolam
-- ============================================================================================

-- Nilai bersih barang masuk aktif (alur baru) sebuah tagihan.
create function ap_bill_pool_received_value(p_bill_id uuid) returns numeric
language sql stable
as $$
  select coalesce(sum(round(gnl.qty * gnl.unit_cost, 2) - coalesce(gnl.discount_amount, 0)), 0)
  from goods_notes gn
  join goods_note_lines gnl on gnl.goods_note_id = gn.id
  where gn.transaction_id = p_bill_id
    and gn.type = 'INBOUND'
    and gn.inbound_flow is null
    and not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
$$;

create function ap_bill_pool_released(p_bill_id uuid, p_kind text default null) returns numeric
language sql stable
as $$
  select coalesce(sum(amount), 0)
  from bill_pool_releases
  where transaction_id = p_bill_id and (p_kind is null or kind = p_kind)
$$;

-- Uang yang sudah dibayar ke tagihan: pembayaran + penerapan uang muka yang belum dibalik.
create function ap_bill_pool_paid(p_bill_id uuid) returns numeric
language sql stable
as $$
  select coalesce((select sum(amount) from payments where transaction_id = p_bill_id and type = 'INBOUND'), 0)
       + coalesce((
           select sum(da.amount) from deposit_applications da
           where da.transaction_id = p_bill_id
             and not exists (select 1 from journal_entries je where je.reverses_entry_id = da.journal_entry_id)
         ), 0)
$$;

-- Sisa kolam = kolam awal - nilai barang masuk aktif - pelepasan. NULL kalau bukan tagihan barang.
create function ap_bill_pool_remaining(p_bill_id uuid) returns numeric
language sql stable
as $$
  select p.amount - ap_bill_pool_received_value(p.transaction_id) - ap_bill_pool_released(p.transaction_id)
  from ap_bill_goods_pools p
  where p.transaction_id = p_bill_id
$$;

create view ap_bill_goods_pool_status
  with (security_invoker = true) as
select
  p.transaction_id as bill_id,
  t.counterparty_id,
  cp.name as supplier_name,
  t.source_ref as bill_ref,
  t.date as bill_date,
  t.status as bill_status,
  p.amount as pool_amount,
  v.received_value,
  v.released_amount,
  p.amount - v.received_value - v.released_amount as remaining,
  case when t.status <> 'dibatalkan' and p.amount - v.received_value - v.released_amount > 0
       then current_date - t.date else null end as open_age_days
from ap_bill_goods_pools p
join transactions t on t.id = p.transaction_id
left join counterparties cp on cp.id = t.counterparty_id
cross join lateral (
  select ap_bill_pool_received_value(p.transaction_id) as received_value,
         ap_bill_pool_released(p.transaction_id) as released_amount
) v;

grant select on ap_bill_goods_pool_status to authenticated;

-- ============================================================================================
-- 5. RPC alur baru
-- ============================================================================================

-- create_ap_bill_with_goods_pool -- tagihan barang: bagian barang jadi kolam. Membungkus create_transaction
-- (baris debit pertama = Pembelian Belum Diterima sebesar p_goods_amount, lalu biaya tambahan/PPN seperti
-- tagihan biasa) lalu mengisi ap_bill_goods_pools di transaksi yang sama.
create function create_ap_bill_with_goods_pool(
  p_supplier_id uuid,
  p_bill_date date,
  p_description text,
  p_source_ref text,
  p_payable_account_id uuid,
  p_goods_amount numeric,
  p_extra_debit_lines jsonb default null, -- array of {"account_id":uuid,"amount":numeric} -- biaya tambahan nota
  p_apply_tax boolean default false,
  p_supplier_document_ref text default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_pbd_account_id uuid;
  v_lines jsonb;
  v_line jsonb;
  v_bill_id uuid;
begin
  if p_goods_amount is null or p_goods_amount <= 0 then
    raise exception 'Nilai barang tagihan harus lebih dari 0';
  end if;
  if p_goods_amount <> round(p_goods_amount, 2) then
    raise exception 'Nilai barang tagihan maksimal 2 desimal';
  end if;

  select account_id into v_pbd_account_id
    from app_default_account_settings where role_key = 'inventory.purchase_not_received';
  if v_pbd_account_id is null then
    raise exception 'Default Akun "Pembelian Belum Diterima" belum diset -- cek Pengaturan > Default Akun';
  end if;

  v_lines := jsonb_build_array(jsonb_build_object('account_id', v_pbd_account_id, 'amount', p_goods_amount));
  if p_extra_debit_lines is not null then
    for v_line in select * from jsonb_array_elements(p_extra_debit_lines)
    loop
      v_lines := v_lines || jsonb_build_array(v_line);
    end loop;
  end if;

  v_bill_id := create_transaction(
    'INBOUND', p_supplier_id, p_bill_date, p_description, p_source_ref,
    v_lines, p_payable_account_id, p_apply_tax, p_supplier_document_ref, 0
  );

  insert into ap_bill_goods_pools (transaction_id, amount, created_by)
  values (v_bill_id, p_goods_amount, auth.uid());

  return v_bill_id;
end;
$$;

grant execute on function create_ap_bill_with_goods_pool(uuid, date, text, text, uuid, numeric, jsonb, boolean, text) to authenticated;

-- create_goods_receipt -- versi final: barang masuk dibuat DARI satu tagihan barang. Signature lama
-- (p_order_id uuid, ..., p_supplier_id uuid, ...) bertipe sama dengan yang baru tapi artinya beda -- drop
-- dulu; UI lama yang memanggil dengan nama parameter lama akan error jelas (bukan salah tulis diam-diam).
drop function create_goods_receipt(uuid, date, text, jsonb, uuid, uuid, numeric);

create function create_goods_receipt(
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
    perform inventory_add_billed(
      v_item_id, v_qty, (round(v_qty * v_unit_cost, 2) - v_line_discount) / v_qty
    );
  end loop;

  return v_note_id;
end;
$$;

grant execute on function create_goods_receipt(uuid, date, text, jsonb, uuid, uuid, numeric) to authenticated;

-- cancel_goods_receipt -- ditulis ulang untuk barang masuk alur baru. Membalik jurnal, mengurangi stok dan
-- avg_cost (rumus pembalikan nilai seperti jalur tagihan lama 0053), kolam kembali (diturunkan, gak disimpan).
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
  v_qty_unbilled numeric;
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
  if v_note.inbound_flow is not null then
    raise exception 'Barang masuk % berasal dari alur lama -- batalkan lewat tagihannya', v_note.source_ref;
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

    select qty_on_hand, qty_unbilled, avg_cost into v_qty_on_hand, v_qty_unbilled, v_avg_cost
      from inventory_balances where item_id = v_item.item_id for update;

    v_pool := coalesce(v_qty_on_hand, 0) - coalesce(v_qty_unbilled, 0);
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

grant execute on function cancel_goods_receipt(uuid, date) to authenticated;

-- release_ap_bill_pool -- lepas sisa kolam yang gak akan terisi barang.
--   pembulatan: seluruh sisa (< satuan pembulatan bank, default Rp1) -> Debit Beban Selisih Pembulatan / Kredit Pembelian Belum Diterima.
--   uang_muka : bagian yang SUDAH DIBAYAR -> Debit Uang Muka Pembelian / Kredit Pembelian Belum Diterima + baris deposits INBOUND.
--               Batas = dibayar - biaya tambahan/PPN (dianggap dibayar duluan) - nilai barang masuk terpakai - uang muka yang sudah dilepas.
-- Sisa yang BELUM dibayar (koreksi utang / nota kredit) belum punya jalur -- scope-debt.
create function release_ap_bill_pool(
  p_bill_id uuid,
  p_kind text,
  p_amount numeric,
  p_release_date date,
  p_source_ref text default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_bill transactions%rowtype;
  v_pool ap_bill_goods_pools%rowtype;
  v_remaining numeric;
  v_pbd_account_id uuid;
  v_counter_account_id uuid;
  v_unit numeric;
  v_paid numeric;
  v_limit numeric;
  v_ref text;
  v_entry_id uuid;
  v_deposit_id uuid;
  v_release_id uuid;
begin
  if p_kind not in ('pembulatan', 'uang_muka') then
    raise exception 'Jenis pelepasan harus pembulatan atau uang_muka, dapat %', p_kind;
  end if;

  perform pg_advisory_xact_lock(hashtext('ap_bill_pool:' || p_bill_id::text));

  select * into v_bill from transactions where id = p_bill_id and type = 'INBOUND';
  if not found then
    raise exception 'Tagihan % gak ditemukan', p_bill_id;
  end if;
  if v_bill.status = 'dibatalkan' then
    raise exception 'Tagihan % sudah dibatalkan', v_bill.source_ref;
  end if;
  select * into v_pool from ap_bill_goods_pools where transaction_id = p_bill_id;
  if not found then
    raise exception 'Tagihan % bukan tagihan barang (gak punya kolam)', v_bill.source_ref;
  end if;

  perform assert_period_open(p_release_date);

  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal pelepasan harus lebih dari 0';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception 'Nominal pelepasan maksimal 2 desimal';
  end if;

  v_remaining := ap_bill_pool_remaining(p_bill_id);
  if p_amount > v_remaining then
    raise exception 'Nominal pelepasan % melebihi sisa kolam tagihan % (sisa %)', p_amount, v_bill.source_ref, v_remaining;
  end if;

  select account_id into v_pbd_account_id
    from app_default_account_settings where role_key = 'inventory.purchase_not_received';
  if v_pbd_account_id is null then
    raise exception 'Default Akun "Pembelian Belum Diterima" belum diset -- cek Pengaturan > Default Akun';
  end if;

  v_ref := coalesce(p_source_ref,
    v_bill.source_ref || '/KLM-' || (select count(*) + 1 from bill_pool_releases where transaction_id = p_bill_id));

  if p_kind = 'pembulatan' then
    v_unit := payment_rounding_unit('BANK');
    if v_unit is null then
      raise exception 'Satuan pembulatan belum diset di app_settings -- hubungi admin';
    end if;
    if p_amount <> v_remaining or v_remaining >= v_unit then
      raise exception 'Pembulatan cuma untuk SELURUH sisa kolam yang kurang dari Rp% (sisa %, diminta %)', v_unit, v_remaining, p_amount;
    end if;

    select account_id into v_counter_account_id
      from app_default_account_settings where role_key = 'rounding.expense';
    if v_counter_account_id is null then
      raise exception 'Default Akun "rounding.expense" belum diset -- hubungi admin';
    end if;

    v_entry_id := create_journal_entry(
      p_release_date, 'Pembulatan sisa kolam tagihan ' || v_bill.source_ref, v_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', v_counter_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', v_pbd_account_id, 'debit', 0, 'credit', p_amount)
      )
    );
  else
    v_paid := ap_bill_pool_paid(p_bill_id);
    v_limit := greatest(0,
      v_paid
      - (v_bill.amount - v_pool.amount)                       -- biaya tambahan + PPN, dianggap dibayar lebih dulu
      - ap_bill_pool_received_value(p_bill_id)                -- nilai barang masuk yang sudah terpakai
      - ap_bill_pool_released(p_bill_id, 'uang_muka'));       -- uang muka yang sudah dilepas sebelumnya
    if p_amount > v_limit then
      raise exception 'Uang muka dari sisa kolam maksimal % (bagian yang sudah dibayar dan belum terpakai); diminta %', v_limit, p_amount;
    end if;

    select account_id into v_counter_account_id
      from app_default_account_settings where role_key = 'ap.deposit_asset';
    if v_counter_account_id is null then
      raise exception 'Default Akun "ap.deposit_asset" (Uang Muka Pembelian) belum diset -- hubungi admin';
    end if;

    v_entry_id := create_journal_entry(
      p_release_date, 'Sisa kolam tagihan ' || v_bill.source_ref || ' jadi uang muka', v_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', v_counter_account_id, 'debit', p_amount, 'credit', 0),
        jsonb_build_object('account_id', v_pbd_account_id, 'debit', 0, 'credit', p_amount)
      )
    );

    insert into deposits (type, counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_by)
    values ('INBOUND', v_bill.counterparty_id, p_release_date, generate_document_number('ap_deposits'),
            p_amount, v_entry_id, auth.uid())
    returning id into v_deposit_id;
  end if;

  insert into bill_pool_releases (transaction_id, kind, amount, release_date, source_ref, journal_entry_id, deposit_id, created_by)
  values (p_bill_id, p_kind, p_amount, p_release_date, v_ref, v_entry_id, v_deposit_id, auth.uid())
  returning id into v_release_id;

  return v_release_id;
end;
$$;

grant execute on function release_ap_bill_pool(uuid, text, numeric, date, text) to authenticated;

-- ============================================================================================
-- 6. Fungsi lama yang harus membaca goods_notes.transaction_id (bukan goods_note_billings)
-- ============================================================================================

-- recompute_transaction_status -- sama persis 0056 kecuali asal (origin) tagihan INBOUND dibaca dari
-- goods_notes.transaction_id (barang masuk berlaku saja).
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
          and (gn.inbound_flow = 'bundled' or goods_note_is_active(gn.id))
      ) then 'financial_only'
      when exists (
        select 1 from goods_notes gn
        where gn.transaction_id = p_transaction_id and gn.type = 'INBOUND'
          and (gn.inbound_flow = 'bundled' or goods_note_is_active(gn.id))
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

-- cancel_ap_bill -- sama persis 0056 kecuali: (1) cabang "alur baru" berbasis foto stok dibuang;
-- (2) tagihan barang (punya kolam) ditolak selama masih ada barang masuk aktif atau pelepasan kolam;
-- (3) cabang tagihan lama (bundled, stok dibalik seperti 0053) membaca goods_notes.transaction_id.
create or replace function cancel_ap_bill(
  p_bill_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_allocated_count int; v_return_count int; v_deposit_count int; v_replacement_count int;
  v_original_entry_id uuid; v_new_entry_id uuid; v_bill_ref text;
  v_has_bundled boolean; v_has_pool boolean;
  v_note record; v_line record; v_order record;
  v_qty_on_hand numeric; v_qty_unbilled numeric; v_avg_cost numeric;
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
    select 1 from goods_notes where transaction_id = p_bill_id and type = 'INBOUND' and inbound_flow = 'bundled'
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
      where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and gn.inbound_flow is null
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
    where gn.transaction_id = p_bill_id and gn.type = 'INBOUND' and gn.inbound_flow = 'bundled'
  loop
    for v_line in
      select id, item_id, qty, unit_cost, coalesce(discount_amount, 0) as discount_amount
      from goods_note_lines where goods_note_id = v_note.id
    loop
      select name into v_item_name from items where id = v_line.item_id;
      select qty_on_hand, qty_unbilled, avg_cost into v_qty_on_hand, v_qty_unbilled, v_avg_cost
        from inventory_balances where item_id = v_line.item_id for update;

      v_pool := coalesce(v_qty_on_hand, 0) - coalesce(v_qty_unbilled, 0);

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

-- return_lines_no_over_return_outbound -- retur ke supplier: batas qty = TOTAL qty diterima dari semua
-- barang masuk aktif di tagihan itu (via goods_notes.transaction_id), per item.
create or replace function return_lines_no_over_return_outbound() returns trigger as $$
declare
  v_bill_id uuid;
  v_qty_received numeric;
  v_rows int;
  v_already numeric;
  v_bill_ref text;
  v_item_name text;
begin
  select transaction_id into v_bill_id from returns where id = new.return_id;

  if not exists (
    select 1 from goods_notes gn
    where gn.transaction_id = v_bill_id and gn.type = 'INBOUND' and goods_note_is_active(gn.id)
  ) then
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Bill % gak punya goods receipt -- gak bisa retur stok per item', v_bill_ref;
  end if;

  select coalesce(sum(gnl.qty), 0), count(*) into v_qty_received, v_rows
    from goods_notes gn
    join goods_note_lines gnl on gnl.goods_note_id = gn.id
    where gn.transaction_id = v_bill_id and gn.type = 'INBOUND' and goods_note_is_active(gn.id)
      and gnl.item_id = new.item_id;

  if v_rows = 0 then
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

-- create_ap_return -- sama persis 0056 kecuali cek "bill punya barang masuk" lewat goods_notes.transaction_id.
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

  select ap_bill_remaining(p_bill_id) into v_remaining_before;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
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

-- replacement_lines_no_over_claim -- sama persis 0056 kecuali tukar barang ke supplier (barang masuk
-- INBOUND): qty tersedia = total qty semua barang masuk aktif tagihan itu (via goods_notes.transaction_id).
create or replace function replacement_lines_no_over_claim() returns trigger as $$
declare
  v_type text;
  v_transaction_id uuid;
  v_goods_note_type text;
  v_goods_note_id uuid;
  v_qty_available numeric;
  v_already_claimed numeric;
  v_item_name text;
  v_transaction_ref text;
  v_rows int;
begin
  select r.type, r.transaction_id into v_type, v_transaction_id
    from replacements r where r.id = new.replacement_id;

  v_goods_note_type := case when v_type = 'INBOUND' then 'OUTBOUND' else 'INBOUND' end;

  if v_goods_note_type = 'INBOUND' then
    if not exists (
      select 1 from goods_notes gn
      where gn.transaction_id = v_transaction_id and gn.type = 'INBOUND' and goods_note_is_active(gn.id)
    ) then
      select source_ref into v_transaction_ref from transactions where id = v_transaction_id;
      raise exception 'Transaksi % gak punya goods note (financial-only) -- gak bisa ganti/tukar barang', v_transaction_ref;
    end if;

    select coalesce(sum(gnl.qty), 0), count(*) into v_qty_available, v_rows
      from goods_notes gn
      join goods_note_lines gnl on gnl.goods_note_id = gn.id
      where gn.transaction_id = v_transaction_id and gn.type = 'INBOUND' and goods_note_is_active(gn.id)
        and gnl.item_id = new.item_id;

    if v_rows = 0 then
      select name into v_item_name from items where id = new.item_id;
      select source_ref into v_transaction_ref from transactions where id = v_transaction_id;
      raise exception 'Item "%" gak ada di goods note transaksi %, gak bisa diganti/ditukar', v_item_name, v_transaction_ref;
    end if;
  else
    select gn.id into v_goods_note_id
      from goods_notes gn where gn.transaction_id = v_transaction_id and gn.type = v_goods_note_type;

    if v_goods_note_id is null then
      select source_ref into v_transaction_ref from transactions where id = v_transaction_id;
      raise exception 'Transaksi % gak punya goods note (financial-only) -- gak bisa ganti/tukar barang', v_transaction_ref;
    end if;

    select gnl.qty into v_qty_available
      from goods_note_lines gnl where gnl.goods_note_id = v_goods_note_id and gnl.item_id = new.item_id;

    if not found then
      select name into v_item_name from items where id = new.item_id;
      select source_ref into v_transaction_ref from transactions where id = v_transaction_id;
      raise exception 'Item "%" gak ada di goods note transaksi %, gak bisa diganti/ditukar', v_item_name, v_transaction_ref;
    end if;
  end if;

  v_already_claimed := case when v_type = 'INBOUND'
    then sales_returned_qty(v_transaction_id, new.item_id)
    else purchase_returned_qty(v_transaction_id, new.item_id)
  end;

  if v_already_claimed + new.qty_replaced > v_qty_available then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Penggantian/penukaran item "%" melebihi qty tersedia dikurangi yang udah diklaim (tersedia %, udah diklaim lewat retur/ganti barang %, coba %)',
      v_item_name, v_qty_available, v_already_claimed, new.qty_replaced;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================================================
-- 7. Putus jalur alur lama: fungsi pembuat barang masuk tanpa tagihan / penagihan dari barang masuk
-- ============================================================================================
drop function if exists revise_goods_receipt(uuid, date, jsonb, uuid, text, numeric);
drop function if exists create_ap_bill_from_goods_receipts(uuid[], date, text, text, uuid, jsonb, boolean, text);
