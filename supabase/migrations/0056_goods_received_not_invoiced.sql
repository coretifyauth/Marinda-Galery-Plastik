-- Barang Masuk Belum Ditagih (Goods Received Not Invoiced). Ref:
-- docs/architecture/goods-notes-schema.md section "Barang Masuk Belum Ditagih (rencana)" dan
-- docs/domain/inventory.md submodule "Barang Masuk Belum Ditagih".
--
-- Ringkasan:
--   * Barang masuk (goods_notes INBOUND) TIDAK lagi otomatis bikin tagihan -- tagihan dibuat
--     terpisah dari 1+ barang masuk (create_ap_bill_from_goods_receipts).
--   * avg_cost cuma dihitung dari stok yang sudah ditagih; stok dari barang masuk belum ditagih
--     dilacak di inventory_balances.qty_unbilled (+ spill_value buat unit yang terjual duluan).
--   * Harga/diskon barang masuk bisa direvisi selama belum ditagih (jurnal lama dibalik, jurnal baru).
--   * Akun baru 2150 Barang Diterima Belum Ditagih (Default Akun inventory.goods_received_not_invoiced).
--   * Data lama (barang masuk yang sudah punya tagihan) tetap berlaku: inbound_flow = 'bundled'.
--
-- Tabel goods_notes/goods_note_lines tetap immutable -- semua perubahan sesudah dibuat dicatat di
-- tabel pendamping baru (append-only), bukan UPDATE. Satu-satunya UPDATE ke goods_notes ada di
-- backfill data lama di bawah (trigger blok-edit dimatikan sebentar, pola 0042).

-- ============================================================================================
-- 1. inventory_balances -- stok belum ditagih + nilai HPP unit yang terjual duluan
-- ============================================================================================
alter table inventory_balances
  add column qty_unbilled numeric(14,3) not null default 0 check (qty_unbilled >= 0),
  add column spill_value numeric(18,4) not null default 0 check (spill_value >= 0),
  add constraint inventory_balances_unbilled_le_qty check (qty_unbilled <= qty_on_hand);

comment on column inventory_balances.qty_unbilled is 'Bagian dari qty_on_hand yang berasal dari barang masuk BELUM ditagih. Stok sudah-ditagih P = qty_on_hand - qty_unbilled; avg_cost cuma mencerminkan P.';
comment on column inventory_balances.spill_value is 'Nilai HPP (qty x avg_cost saat itu) unit yang terjual dari barang masuk belum ditagih karena stok sudah-ditagih habis. Dipakai saat tagihan dibuat buat hitung koreksi HPP; HPP lama gak pernah diubah.';

-- ============================================================================================
-- 2. goods_notes -- supplier sendiri, jenis alur INBOUND, constraint dilonggarkan
-- ============================================================================================
alter table goods_notes
  add column counterparty_id uuid references counterparties(id),
  add column inbound_flow text check (inbound_flow in ('bundled', 'deferred'));

comment on column goods_notes.counterparty_id is 'Supplier barang masuk (cuma INBOUND). Dulu diturunkan dari transactions lewat transaction_id; sekarang barang masuk belum punya tagihan jadi harus disimpan sendiri.';
comment on column goods_notes.inbound_flow is 'INBOUND saja. bundled = alur lama (barang masuk dibuat bareng tagihannya, jurnal ada di tagihan). deferred = alur baru (jurnal Persediaan/Barang Diterima Belum Ditagih di barang masuk, tagihan menyusul lewat goods_note_billings).';

-- Backfill data lama -- semua INBOUND yang ada sudah punya tagihan (transaction_id NOT NULL).
alter table goods_notes disable trigger goods_notes_block_edit_delete;
update goods_notes gn
  set counterparty_id = t.counterparty_id, inbound_flow = 'bundled'
  from transactions t
  where t.id = gn.transaction_id and gn.type = 'INBOUND';
alter table goods_notes enable trigger goods_notes_block_edit_delete;

alter table goods_notes alter column transaction_id drop not null;
alter table goods_notes drop constraint goods_notes_journal_entry_outbound_only;
alter table goods_notes drop constraint goods_notes_source_ref_outbound_only;
alter table goods_notes
  add constraint goods_notes_outbound_required
    check (type <> 'OUTBOUND' or (transaction_id is not null and journal_entry_id is not null and source_ref is not null)),
  add constraint goods_notes_inbound_flow_set
    check ((type = 'INBOUND') = (inbound_flow is not null)),
  add constraint goods_notes_inbound_supplier
    check (type <> 'INBOUND' or counterparty_id is not null),
  add constraint goods_notes_bundled_has_transaction
    check (inbound_flow is distinct from 'bundled' or transaction_id is not null),
  add constraint goods_notes_deferred_shape
    check (inbound_flow is distinct from 'deferred' or (source_ref is not null and transaction_id is null));

create index goods_notes_counterparty_id_idx on goods_notes(counterparty_id);

-- ============================================================================================
-- 3. goods_note_lines -- harga 0 boleh (belum tahu), diskon gak boleh melebihi nilai baris
-- ============================================================================================
alter table goods_note_lines drop constraint goods_note_lines_unit_cost_check;
alter table goods_note_lines
  add constraint goods_note_lines_unit_cost_check check (unit_cost is null or unit_cost >= 0),
  add constraint goods_note_lines_inbound_discount_le_subtotal
    check (unit_cost is null or discount_amount <= qty * unit_cost + 0.005) not valid;

-- ============================================================================================
-- 4. Tabel pendamping (append-only)
-- ============================================================================================

-- 4a. Penghubung barang masuk -> tagihan. 1 barang masuk paling banyak 1 tagihan AKTIF
-- (dijaga trigger di bawah; tagihan yang dibatalkan melepas barang masuknya).
create table goods_note_billings (
  id uuid primary key default gen_random_uuid(),
  goods_note_id uuid not null references goods_notes(id),
  transaction_id uuid not null references transactions(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index goods_note_billings_goods_note_id_idx on goods_note_billings(goods_note_id);
create index goods_note_billings_transaction_id_idx on goods_note_billings(transaction_id);

-- Backfill: seluruh barang masuk lama sudah punya tagihan (dibuat bareng).
insert into goods_note_billings (goods_note_id, transaction_id, created_by)
select id, transaction_id, created_by
from goods_notes
where type = 'INBOUND' and inbound_flow = 'bundled';

-- 4b. Foto kondisi stok sebelum ditagih, per (tagihan, item) -- dipakai membatalkan tagihan persis.
create table goods_note_billing_allocations (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  item_id uuid not null references items(id),
  avg_before numeric(14,2) not null,
  avg_after numeric(14,2) not null,
  qty_on_hand_after numeric(14,3) not null,
  unbilled_before numeric(14,3) not null,
  unbilled_after numeric(14,3) not null,
  spill_value_before numeric(18,4) not null,
  spill_value_after numeric(18,4) not null,
  qty_remaining numeric(14,3) not null,
  qty_spilled numeric(14,3) not null,
  hpp_correction numeric(18,4) not null default 0,
  hpp_journal_entry_id uuid references journal_entries(id),
  created_at timestamptz not null default now(),
  unique (transaction_id, item_id)
);

-- 4c. Pembatalan barang masuk belum ditagih.
create table goods_note_cancellations (
  goods_note_id uuid primary key references goods_notes(id),
  journal_entry_id uuid references journal_entries(id),
  cancelled_at timestamptz not null default now(),
  cancelled_by uuid references auth.users(id)
);

-- 4d. Revisi harga/diskon (revisi 1 = nilai asli di goods_note_lines; revisi >= 2 di sini).
create table goods_note_revisions (
  id uuid primary key default gen_random_uuid(),
  goods_note_id uuid not null references goods_notes(id),
  revision_no int not null check (revision_no >= 2),
  delivery_note_ref text,
  reversal_journal_entry_id uuid references journal_entries(id),
  journal_entry_id uuid references journal_entries(id),
  entry_date date not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (goods_note_id, revision_no)
);

create table goods_note_revision_lines (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references goods_note_revisions(id),
  goods_note_line_id uuid not null references goods_note_lines(id),
  unit_cost numeric(14,2) not null check (unit_cost >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  unique (revision_id, goods_note_line_id)
);

create index goods_note_revisions_goods_note_id_idx on goods_note_revisions(goods_note_id);
create index goods_note_revision_lines_line_id_idx on goods_note_revision_lines(goods_note_line_id);

-- Immutable + RLS (pola sama tabel transaksional lain: select semua authenticated, insert admin).
create trigger goods_note_billings_block_edit_delete before update or delete on goods_note_billings
  for each row execute function block_edit_delete();
create trigger goods_note_billing_allocations_block_edit_delete before update or delete on goods_note_billing_allocations
  for each row execute function block_edit_delete();
create trigger goods_note_cancellations_block_edit_delete before update or delete on goods_note_cancellations
  for each row execute function block_edit_delete();
create trigger goods_note_revisions_block_edit_delete before update or delete on goods_note_revisions
  for each row execute function block_edit_delete();
create trigger goods_note_revision_lines_block_edit_delete before update or delete on goods_note_revision_lines
  for each row execute function block_edit_delete();

alter table goods_note_billings enable row level security;
alter table goods_note_billing_allocations enable row level security;
alter table goods_note_cancellations enable row level security;
alter table goods_note_revisions enable row level security;
alter table goods_note_revision_lines enable row level security;

create policy goods_note_billings_select on goods_note_billings for select using (auth.role() = 'authenticated');
create policy goods_note_billing_allocations_select on goods_note_billing_allocations for select using (auth.role() = 'authenticated');
create policy goods_note_cancellations_select on goods_note_cancellations for select using (auth.role() = 'authenticated');
create policy goods_note_revisions_select on goods_note_revisions for select using (auth.role() = 'authenticated');
create policy goods_note_revision_lines_select on goods_note_revision_lines for select using (auth.role() = 'authenticated');

create policy goods_note_billings_insert on goods_note_billings for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin'));
create policy goods_note_billing_allocations_insert on goods_note_billing_allocations for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin'));
create policy goods_note_cancellations_insert on goods_note_cancellations for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin'));
create policy goods_note_revisions_insert on goods_note_revisions for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin'));
create policy goods_note_revision_lines_insert on goods_note_revision_lines for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin'));

grant select, insert on goods_note_billings to authenticated;
grant select, insert on goods_note_billing_allocations to authenticated;
grant select, insert on goods_note_cancellations to authenticated;
grant select, insert on goods_note_revisions to authenticated;
grant select, insert on goods_note_revision_lines to authenticated;

-- ============================================================================================
-- 5. Guard & trigger penghubung tagihan (dibuat SETELAH backfill supaya gak menolak data lama)
-- ============================================================================================
create function goods_note_billings_guard() returns trigger as $$
declare
  v_note goods_notes%rowtype;
  v_bill_supplier uuid;
begin
  select * into v_note from goods_notes where id = new.goods_note_id;

  if v_note.type <> 'INBOUND' or v_note.inbound_flow is distinct from 'deferred' then
    raise exception 'Barang masuk % bukan barang masuk alur baru -- gak bisa ditagih lewat penghubung', new.goods_note_id;
  end if;

  if exists (select 1 from goods_note_cancellations c where c.goods_note_id = new.goods_note_id) then
    raise exception 'Barang masuk % sudah dibatalkan -- gak bisa ditagih', v_note.source_ref;
  end if;

  if exists (
    select 1 from goods_note_billings b
    join transactions t on t.id = b.transaction_id
    where b.goods_note_id = new.goods_note_id and t.status <> 'dibatalkan'
  ) then
    raise exception 'Barang masuk % sudah ditagih oleh tagihan aktif lain', v_note.source_ref;
  end if;

  select counterparty_id into v_bill_supplier from transactions where id = new.transaction_id;
  if v_bill_supplier is distinct from v_note.counterparty_id then
    raise exception 'Barang masuk % milik supplier lain -- 1 tagihan cuma boleh menggabungkan barang masuk 1 supplier', v_note.source_ref;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_note_billings_guard_trigger
  before insert on goods_note_billings
  for each row execute function goods_note_billings_guard();

create function goods_note_billings_sync_status() returns trigger as $$
declare
  v_order_id uuid;
begin
  perform recompute_transaction_status(new.transaction_id);
  select order_id into v_order_id from goods_notes where id = new.goods_note_id;
  if v_order_id is not null then
    perform recompute_order_status(v_order_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_note_billings_sync_status_trigger
  after insert on goods_note_billings
  for each row execute function goods_note_billings_sync_status();

-- ============================================================================================
-- 6. Fungsi bantu baca (stable) + view
-- ============================================================================================

-- Barang masuk dianggap "berlaku" (qty-nya terhitung diterima) kalau:
--   OUTBOUND: transaksinya belum dibatalkan.
--   INBOUND bundled (alur lama): tagihannya belum dibatalkan (pembatalan tagihan lama membalik stok).
--   INBOUND deferred (alur baru): belum dibatalkan sebagai barang masuk (pembatalan TAGIHAN gak
--   membatalkan barang masuk -- cuma melepasnya jadi belum tertagih).
create function goods_note_is_active(p_goods_note_id uuid) returns boolean
language sql stable
as $$
  select case
    when gn.type = 'INBOUND' and gn.inbound_flow = 'deferred'
      then not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
    else coalesce(t.status, '') <> 'dibatalkan'
  end
  from goods_notes gn
  left join transactions t on t.id = gn.transaction_id
  where gn.id = p_goods_note_id
$$;

-- Biaya berlaku per baris barang masuk (INBOUND): revisi terakhir, atau nilai asli kalau belum pernah direvisi.
create view goods_note_line_current_cost
  with (security_invoker = true) as
select
  gnl.id as goods_note_line_id,
  gnl.goods_note_id,
  gnl.item_id,
  gnl.qty,
  coalesce(rev.unit_cost, gnl.unit_cost) as unit_cost,
  coalesce(rev.discount_amount, gnl.discount_amount) as discount_amount,
  round(gnl.qty * coalesce(rev.unit_cost, gnl.unit_cost), 2) - coalesce(rev.discount_amount, gnl.discount_amount) as line_value,
  (round(gnl.qty * coalesce(rev.unit_cost, gnl.unit_cost), 2) - coalesce(rev.discount_amount, gnl.discount_amount)) / gnl.qty as net_unit_cost
from goods_note_lines gnl
left join lateral (
  select rl.unit_cost, rl.discount_amount
  from goods_note_revision_lines rl
  join goods_note_revisions r on r.id = rl.revision_id
  where rl.goods_note_line_id = gnl.id
  order by r.revision_no desc
  limit 1
) rev on true
where gnl.unit_cost is not null;

grant select on goods_note_line_current_cost to authenticated;

-- Alokasi qty terjual-duluan ke barang masuk belum ditagih satu item, paling lama dulu (FIFO).
-- S = (jumlah qty semua barang masuk belum ditagih item itu) - qty_unbilled. Dihitung, gak disimpan.
create function grni_spill_allocation(p_item_id uuid)
returns table (goods_note_id uuid, qty_total numeric, qty_spilled numeric, qty_remaining numeric)
language sql stable
as $$
  with unb as (
    select gn.id, gn.note_date, gn.created_at, sum(gnl.qty) as q
    from goods_notes gn
    join goods_note_lines gnl on gnl.goods_note_id = gn.id
    where gn.type = 'INBOUND' and gn.inbound_flow = 'deferred'
      and gnl.item_id = p_item_id
      and not exists (select 1 from goods_note_cancellations c where c.goods_note_id = gn.id)
      and not exists (
        select 1 from goods_note_billings b
        join transactions t on t.id = b.transaction_id
        where b.goods_note_id = gn.id and t.status <> 'dibatalkan'
      )
    group by gn.id, gn.note_date, gn.created_at
  ),
  ord as (
    select u.*, coalesce(sum(u.q) over (order by u.note_date, u.created_at, u.id
                                         rows between unbounded preceding and 1 preceding), 0) as cum_before
    from unb u
  ),
  s as (
    select greatest(0, (select coalesce(sum(q), 0) from unb)
                       - coalesce((select qty_unbilled from inventory_balances where item_id = p_item_id), 0)) as spill
  )
  select o.id, o.q,
         least(o.q, greatest(0, s.spill - o.cum_before)),
         o.q - least(o.q, greatest(0, s.spill - o.cum_before))
  from ord o cross join s
$$;

-- Status turunan barang masuk (INBOUND): belum_tertagih / tertagih / dibatalkan. Sekalian membawa
-- data yang dibutuhkan daftar (supplier, PO, tagihan aktif, pembuat) supaya cukup 1 query.
-- bill_id: alur baru = tagihan AKTIF dari goods_note_billings; alur lama (bundled) = tagihan bawaannya
-- (walau sudah dibatalkan, biar nomornya tetap terlihat).
create view goods_notes_with_billing_status
  with (security_invoker = true) as
select
  gn.id,
  gn.counterparty_id,
  cp.name as supplier_name,
  gn.note_date,
  gn.source_ref,
  coalesce(
    (select r.delivery_note_ref from goods_note_revisions r
      where r.goods_note_id = gn.id and r.delivery_note_ref is not null
      order by r.revision_no desc limit 1),
    gn.delivery_note_ref
  ) as delivery_note_ref,
  gn.order_id,
  o.source_ref as order_ref,
  gn.inbound_flow,
  gn.created_at,
  gn.created_by,
  case
    when c.goods_note_id is not null then 'dibatalkan'
    when ab.transaction_id is not null then 'tertagih'
    when gn.inbound_flow = 'bundled' then 'dibatalkan'
    else 'belum_tertagih'
  end as billing_status,
  bt.id as bill_id,
  bt.source_ref as bill_ref,
  bt.amount as bill_amount,
  coalesce(v.total_value, 0) as total_value,
  coalesce((select max(r.revision_no) from goods_note_revisions r where r.goods_note_id = gn.id), 1) as revision_no,
  case when c.goods_note_id is null and ab.transaction_id is null and gn.inbound_flow = 'deferred'
       then current_date - gn.note_date else null end as unbilled_age_days
from goods_notes gn
left join counterparties cp on cp.id = gn.counterparty_id
left join orders o on o.id = gn.order_id
left join goods_note_cancellations c on c.goods_note_id = gn.id
left join lateral (
  select b.transaction_id
  from goods_note_billings b
  join transactions t on t.id = b.transaction_id
  where b.goods_note_id = gn.id and t.status <> 'dibatalkan'
  limit 1
) ab on true
left join transactions bt on bt.id = case when gn.inbound_flow = 'bundled' then gn.transaction_id else ab.transaction_id end
left join lateral (
  select sum(cc.line_value) as total_value
  from goods_note_line_current_cost cc where cc.goods_note_id = gn.id
) v on true
where gn.type = 'INBOUND';

grant select on goods_notes_with_billing_status to authenticated;

-- ============================================================================================
-- 7. Data referensi: jenis dokumen + akun Barang Diterima Belum Ditagih
-- ============================================================================================
insert into document_number_types (doc_type, prefix, label) values
  ('goods_receipts', 'GRN', 'Barang Masuk')
on conflict (doc_type) do nothing;

-- DB yang SUDAH lewat onboarding (app_settings ada): akun + peran Default Akun dibuat di sini
-- (pola 0054). DB yang belum di-setup dilewati -- template onboarding (bootstrap_default_accounts
-- di bawah) yang mengisinya. Gagal keras kalau kode 2150 sudah dipakai akun lain.
do $$
declare
  v_count int;
begin
  if not exists (select 1 from app_settings) then
    return;
  end if;

  insert into accounts (code, name, category, is_contra) values
    ('2150', 'Barang Diterima Belum Ditagih', 'liability', false)
  on conflict (code) do nothing;

  insert into app_default_account_settings (role_key, label, account_id)
    select 'inventory.goods_received_not_invoiced', 'Barang Diterima Belum Ditagih', id
    from accounts
    where code = '2150' and name = 'Barang Diterima Belum Ditagih' and category = 'liability'::account_category
  on conflict (role_key) do nothing;

  select count(*) into v_count
    from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced';
  if v_count <> 1 then
    raise exception 'Default Akun Barang Diterima Belum Ditagih gagal di-resolve -- kode akun 2150 kemungkinan sudah dipakai akun lain';
  end if;
end;
$$;

-- bootstrap_default_accounts -- template onboarding ditambah akun 2150 + peran ke-22. Isi lama
-- dipertahankan apa adanya: fungsi lama di-rename jadi _base (dicabut dari authenticated), fungsi
-- baru dengan nama lama memanggilnya lalu menambah akun baru (idempotent).
alter function bootstrap_default_accounts() rename to bootstrap_default_accounts_base;
revoke execute on function bootstrap_default_accounts_base() from authenticated, anon, public;

create function bootstrap_default_accounts() returns void
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
    ('2150', 'Barang Diterima Belum Ditagih', 'liability', false)
  on conflict (code) do nothing;

  insert into app_default_account_settings (role_key, label, account_id)
    select 'inventory.goods_received_not_invoiced', 'Barang Diterima Belum Ditagih', id
    from accounts
    where code = '2150' and name = 'Barang Diterima Belum Ditagih' and category = 'liability'::account_category
  on conflict (role_key) do nothing;

  select count(*) into v_count
    from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced';
  if v_count <> 1 then
    raise exception 'Bootstrap Default Akun Barang Diterima Belum Ditagih gagal -- kode akun 2150 kemungkinan sudah dipakai akun lain';
  end if;
end;
$$;

grant execute on function bootstrap_default_accounts() to authenticated;

-- ============================================================================================
-- 8. Fungsi stok bersama
-- ============================================================================================

-- consume_weighted_average -- satu-satunya jalur konsumsi stok. Perubahan vs 0023:
--   (1) menolak kalau avg_cost = 0 (biaya pokok belum diketahui -- barang masuk belum ditagih);
--   (2) konsumsi menghabiskan stok sudah-ditagih (P = qty_on_hand - qty_unbilled) dulu; kelebihannya (y)
--       diambil dari barang masuk belum ditagih: qty_unbilled -= y, spill_value += y x avg_cost;
--   (3) avg_cost gak berubah, biaya yang dikembalikan tetap qty x avg_cost.
create or replace function consume_weighted_average(p_item_id uuid, p_qty_needed numeric) returns numeric
language plpgsql
security invoker
as $$
declare
  v_qty_on_hand numeric;
  v_qty_unbilled numeric;
  v_avg_cost numeric;
  v_item_name text;
  v_billed_pool numeric;
  v_from_billed numeric;
  v_spill numeric;
begin
  select qty_on_hand, qty_unbilled, avg_cost into v_qty_on_hand, v_qty_unbilled, v_avg_cost
    from inventory_balances where item_id = p_item_id for update;

  if not found or v_qty_on_hand < p_qty_needed then
    select name into v_item_name from items where id = p_item_id;
    raise exception 'Stok Weighted Average item "%" gak cukup (tersedia %, butuh %)',
      coalesce(v_item_name, p_item_id::text), coalesce(v_qty_on_hand, 0), p_qty_needed;
  end if;

  if v_avg_cost = 0 then
    select name into v_item_name from items where id = p_item_id;
    raise exception 'Item "%" belum punya harga pokok (barang masuknya belum ditagih) -- gak bisa dijual/dikonsumsi sampai ditagih', v_item_name;
  end if;

  v_billed_pool := v_qty_on_hand - v_qty_unbilled;
  v_from_billed := least(p_qty_needed, v_billed_pool);
  v_spill := p_qty_needed - v_from_billed;

  update inventory_balances
    set qty_on_hand = v_qty_on_hand - p_qty_needed,
        qty_unbilled = v_qty_unbilled - v_spill,
        spill_value = spill_value + v_spill * v_avg_cost,
        updated_at = now()
    where item_id = p_item_id;

  return p_qty_needed * v_avg_cost;
end;
$$;

-- inventory_add_billed -- tambah stok SUDAH-DITAGIH pada biaya tertentu (hasil produksi, barang
-- pengganti dari supplier): avg_cost dicampur memakai stok sudah-ditagih P (bukan seluruh
-- qty_on_hand), qty_unbilled/spill_value gak berubah.
create function inventory_add_billed(p_item_id uuid, p_qty numeric, p_unit_cost numeric) returns void
language plpgsql
security invoker
as $$
declare
  v_qty_on_hand numeric;
  v_qty_unbilled numeric;
  v_avg_cost numeric;
  v_billed_pool numeric;
begin
  select qty_on_hand, qty_unbilled, avg_cost into v_qty_on_hand, v_qty_unbilled, v_avg_cost
    from inventory_balances where item_id = p_item_id for update;

  if not found then
    insert into inventory_balances (item_id, qty_on_hand, avg_cost) values (p_item_id, p_qty, p_unit_cost);
    return;
  end if;

  v_billed_pool := v_qty_on_hand - v_qty_unbilled;

  update inventory_balances
    set qty_on_hand = v_qty_on_hand + p_qty,
        avg_cost = (v_billed_pool * v_avg_cost + p_qty * p_unit_cost) / (v_billed_pool + p_qty),
        updated_at = now()
    where item_id = p_item_id;
end;
$$;

-- create_production_order -- sama persis 0011 kecuali hasil produksi masuk lewat inventory_add_billed
-- (avg_cost dicampur dengan stok sudah-ditagih, bukan seluruh qty_on_hand).
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

  perform inventory_add_billed(v_finished_item_id, p_qty_produced, v_unit_cost);

  return v_po_id;
end;
$$;

-- create_replacement -- sama persis 0021 kecuali barang pengganti dari supplier (OUTBOUND) masuk
-- lewat inventory_add_billed.
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
      perform inventory_add_billed(v_item_id, v_qty, v_unit_cost);
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

-- record_stock_opname -- sama persis 0012 kecuali: kekurangan stok lewat consume_weighted_average
-- (pembagian stok sudah-ditagih/belum + spill_value konsisten dengan penjualan), kelebihan menambah
-- stok sudah-ditagih; item dengan avg_cost 0 ditolak (nilai selisih 0 gak bisa dijurnal).
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
      raise exception 'Item "%" belum punya harga pokok (barang masuknya belum ditagih) -- opname ditolak, tagih barang masuknya dulu', v_item_name;
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

-- assert_period_open -- tolak tanggal yang masuk periode yang sudah ditutup (period_closings). Barang masuk
-- bernilai 0 gak punya jurnal, jadi guard di journal_entries gak jalan buat mereka -- dicek langsung di sini.
create function assert_period_open(p_date date) returns void
language plpgsql
stable
as $$
begin
  if exists (select 1 from period_closings where p_date between start_date and end_date) then
    raise exception 'Tanggal % sudah masuk periode yang ditutup — catat dengan tanggal periode yang sedang berjalan, bukan tanggal lama', p_date;
  end if;
end;
$$;

-- inventory_restore_stock -- stok KEMBALI (void/pembatalan penjualan, retur dari customer). Unit yang dulu
-- terjual "duluan" dari barang masuk belum ditagih (spill) diisi kembali lebih dulu ke qty_unbilled,
-- spill_value dikurangi sebesar rata-rata nilai spill; sisanya masuk stok sudah-ditagih. Kalau
-- p_unit_cost diisi (retur dari customer), avg_cost dicampur HANYA dengan bagian yang masuk stok
-- sudah-ditagih (P), bukan seluruh qty_on_hand. Tanpa ini penagihan sesudahnya menjurnal koreksi HPP
-- untuk penjualan yang sudah dibatalkan.
create function inventory_restore_stock(p_item_id uuid, p_qty numeric, p_unit_cost numeric default null) returns void
language plpgsql
security invoker
as $$
declare
  v_qty_on_hand numeric;
  v_qty_unbilled numeric;
  v_avg_cost numeric;
  v_spill_value numeric;
  v_spill_qty numeric;
  v_refill numeric;
  v_avgspill numeric;
  v_rest numeric;
  v_billed_pool numeric;
begin
  select qty_on_hand, qty_unbilled, avg_cost, spill_value into v_qty_on_hand, v_qty_unbilled, v_avg_cost, v_spill_value
    from inventory_balances where item_id = p_item_id for update;

  if not found then
    insert into inventory_balances (item_id, qty_on_hand, avg_cost) values (p_item_id, p_qty, coalesce(p_unit_cost, 0));
    return;
  end if;

  select coalesce(sum(qty_spilled), 0) into v_spill_qty from grni_spill_allocation(p_item_id);
  v_refill := least(p_qty, v_spill_qty);
  v_avgspill := case when v_spill_qty > 0.0005 then v_spill_value / v_spill_qty else 0 end;
  v_rest := p_qty - v_refill;
  v_billed_pool := v_qty_on_hand - v_qty_unbilled;

  update inventory_balances
    set qty_on_hand = v_qty_on_hand + p_qty,
        qty_unbilled = v_qty_unbilled + v_refill,
        spill_value = greatest(0, v_spill_value - v_refill * v_avgspill),
        avg_cost = case
          when p_unit_cost is not null and v_rest > 0.0005 and v_billed_pool + v_rest > 0
            then (v_billed_pool * v_avg_cost + v_rest * p_unit_cost) / (v_billed_pool + v_rest)
          else avg_cost end,
        updated_at = now()
    where item_id = p_item_id;
end;
$$;

-- void_pos_transaction -- sama persis 0024 kecuali stok dikembalikan lewat inventory_restore_stock.
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

-- cancel_ar_invoice -- sama persis 0053 kecuali stok dikembalikan lewat inventory_restore_stock.
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
  from payments where transaction_id = p_invoice_id and type = 'OUTBOUND';

  if v_paid_count > 0 then
    raise exception 'Invoice % udah punya payment -- gak bisa dibatalkan lewat jalur ini', v_invoice_ref;
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

-- create_ar_return -- sama persis 0019 kecuali stok yang kembali lewat inventory_restore_stock
-- (avg_cost dicampur dengan stok sudah-ditagih saja, spill diisi kembali dulu).
create or replace function create_ar_return(
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
    select id into v_goods_issue_id from goods_notes where transaction_id = p_invoice_id and type = 'OUTBOUND';

    if v_goods_issue_id is null then
      raise exception 'Invoice % gak punya goods issue — gak bisa retur stok/HPP', p_invoice_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;

      select qty, total_cost into v_qty_issued, v_total_cost
        from goods_note_lines
        where goods_note_id = v_goods_issue_id and item_id = v_item_id;

      if not found then
        raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', v_item_id, v_goods_issue_id;
      end if;

      v_unit_cost := v_total_cost / v_qty_issued;
      v_line_cost := v_qty_returned * v_unit_cost;
      v_total_cost_returned := v_total_cost_returned + v_line_cost;

      perform inventory_restore_stock(v_item_id, v_qty_returned, v_unit_cost);

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
-- ============================================================================================
-- 9. RPC barang masuk (tanpa tagihan)
-- ============================================================================================

-- grn_prorate_discount -- diskon total per baris = diskon item (input per baris) + bagian dari diskon
-- header yang diproratakan sebanding nilai baris (qty x harga - diskon item), teknik CUMULATIVE
-- rounding seperti create_goods_receipt lama (sisa pembulatan ke baris terakhir). Input tiap elemen
-- p_lines: {"qty", "unit_cost", "discount_amount" (diskon item, opsional)}. Output: array diskon total
-- per baris, urutan sama dengan input. Semua nilai dibulatkan 2 desimal.
create function grn_prorate_discount(p_lines jsonb, p_header_discount numeric) returns numeric[]
language plpgsql
immutable
as $$
declare
  v_n int := jsonb_array_length(p_lines);
  v_i int := 0;
  v_line jsonb;
  v_qty numeric;
  v_cost numeric;
  v_item_disc numeric;
  v_base numeric;
  v_total_base numeric := 0;
  v_cum_base numeric := 0;
  v_prev_cum_disc numeric := 0;
  v_target numeric;
  v_share numeric;
  v_result numeric[] := '{}';
begin
  if p_header_discount < 0 then
    raise exception 'Diskon header gak boleh negatif';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_i := v_i + 1;
    v_qty := (v_line->>'qty')::numeric;
    v_cost := (v_line->>'unit_cost')::numeric;
    v_item_disc := round(coalesce((v_line->>'discount_amount')::numeric, 0), 2);

    if v_qty <= 0 then
      raise exception 'Qty baris ke-% harus lebih dari 0', v_i;
    end if;
    if v_cost < 0 then
      raise exception 'Harga baris ke-% gak boleh negatif', v_i;
    end if;
    if v_item_disc < 0 then
      raise exception 'Diskon item baris ke-% gak boleh negatif', v_i;
    end if;

    v_base := round(v_qty * v_cost, 2) - v_item_disc;
    if v_base < 0 then
      raise exception 'Diskon item baris ke-% (%) melebihi nilai barisnya (%)', v_i, v_item_disc, round(v_qty * v_cost, 2);
    end if;
    v_total_base := v_total_base + v_base;
  end loop;

  if p_header_discount > v_total_base then
    raise exception 'Diskon header (%) melebihi nilai pembelian setelah diskon item (%)', p_header_discount, v_total_base;
  end if;

  v_i := 0;
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_i := v_i + 1;
    v_qty := (v_line->>'qty')::numeric;
    v_cost := (v_line->>'unit_cost')::numeric;
    v_item_disc := round(coalesce((v_line->>'discount_amount')::numeric, 0), 2);
    v_base := round(v_qty * v_cost, 2) - v_item_disc;
    v_cum_base := v_cum_base + v_base;

    if p_header_discount = 0 then
      v_share := 0;
    elsif v_i = v_n then
      v_share := p_header_discount - v_prev_cum_disc;
    else
      v_target := round(p_header_discount * v_cum_base / v_total_base, 2);
      v_share := v_target - v_prev_cum_disc;
    end if;
    v_prev_cum_disc := v_prev_cum_disc + v_share;

    if v_share < 0 or v_share > v_base then
      raise exception 'Diskon header gak bisa diproratakan wajar ke baris ke-% (bagian % > nilai baris %) -- kurangi nominal diskon', v_i, v_share, v_base;
    end if;

    v_result := v_result || (v_item_disc + v_share);
  end loop;

  return v_result;
end;
$$;

-- create_goods_receipt -- versi baru: barang masuk TANPA tagihan. Signature berubah total
-- (param tagihan hilang) -- drop yang lama biar gak ada overload nganggur.
drop function create_goods_receipt(uuid, date, text, jsonb, text, text, uuid, uuid, jsonb, boolean, uuid, numeric);

create function create_goods_receipt(
  p_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- array of {"order_line_id":uuid|null,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric,"discount_amount":numeric (diskon item, opsional)}
  p_inventory_account_id uuid, -- akun Persediaan yang didebit
  p_supplier_id uuid default null,
  p_discount_amount numeric default 0 -- diskon header (di atas diskon item), diproratakan ke baris
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_supplier_id uuid;
  v_grni_account_id uuid;
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
  v_source_ref text;
  v_entry_id uuid;
  v_note_id uuid;
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
      select 1 from counterparty_type_mapping where counterparty_id = p_supplier_id and role = 'supplier'
    ) then
      raise exception 'Supplier % gak ditemukan', p_supplier_id;
    end if;
    v_supplier_id := p_supplier_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Barang masuk butuh minimal 1 baris item';
  end if;

  perform assert_period_open(p_receipt_date);

  select account_id into v_grni_account_id
    from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced';
  if v_grni_account_id is null then
    raise exception 'Default Akun "Barang Diterima Belum Ditagih" belum diset -- cek Pengaturan > Default Akun';
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
    v_line_value := round((v_line->>'qty_received')::numeric * (v_line->>'unit_cost')::numeric, 2) - v_discounts[v_idx];
    v_total_value := v_total_value + v_line_value;
  end loop;

  v_source_ref := generate_document_number('goods_receipts');

  if v_total_value > 0 then
    v_entry_id := create_journal_entry(
      p_receipt_date, 'Barang masuk ' || v_source_ref, v_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_inventory_account_id, 'debit', v_total_value, 'credit', 0),
        jsonb_build_object('account_id', v_grni_account_id, 'debit', 0, 'credit', v_total_value)
      )
    );
  end if;

  insert into goods_notes (type, order_id, delivery_note_ref, note_date, created_by,
                           counterparty_id, inbound_flow, source_ref, journal_entry_id)
  values ('INBOUND', p_order_id, p_delivery_note_ref, p_receipt_date, auth.uid(),
          v_supplier_id, 'deferred', v_source_ref, v_entry_id)
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

    -- stok fisik naik, avg_cost TIDAK berubah (baru dihitung saat tagihan dibuat)
    insert into inventory_balances (item_id, qty_on_hand, avg_cost, qty_unbilled)
    values (v_item_id, v_qty, 0, v_qty)
    on conflict (item_id) do update
      set qty_on_hand = inventory_balances.qty_on_hand + excluded.qty_on_hand,
          qty_unbilled = inventory_balances.qty_unbilled + excluded.qty_unbilled,
          updated_at = now();
  end loop;

  return v_note_id;
end;
$$;

grant execute on function create_goods_receipt(uuid, date, text, jsonb, uuid, uuid, numeric) to authenticated;

-- revise_goods_receipt -- revisi harga/diskon/nomor surat jalan barang masuk BELUM ditagih.
-- Jurnal yang berlaku dibalik (bertanggal p_entry_date), jurnal baru dibuat dari nilai terbaru
-- (dilewati kalau nilainya 0). Stok dan avg_cost TIDAK disentuh.
create function revise_goods_receipt(
  p_goods_note_id uuid,
  p_entry_date date,
  p_lines jsonb, -- array of {"goods_note_line_id":uuid,"unit_cost":numeric,"discount_amount":numeric (diskon item)} -- SEMUA baris
  p_inventory_account_id uuid,
  p_delivery_note_ref text default null,
  p_discount_amount numeric default 0
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_note goods_notes%rowtype;
  v_status text;
  v_grni_account_id uuid;
  v_revision_no int;
  v_revision_id uuid;
  v_current_journal uuid;
  v_reversal_id uuid;
  v_new_entry_id uuid;
  v_calc jsonb;
  v_discounts numeric[];
  v_line jsonb;
  v_idx int := 0;
  v_qty numeric;
  v_value numeric := 0;
  v_expected_count int;
  v_given_count int;
begin
  perform pg_advisory_xact_lock(hashtext('goods_receipt:' || p_goods_note_id::text));

  select * into v_note from goods_notes where id = p_goods_note_id and type = 'INBOUND';
  if not found then
    raise exception 'Barang masuk % gak ditemukan', p_goods_note_id;
  end if;
  if v_note.inbound_flow is distinct from 'deferred' then
    raise exception 'Barang masuk % dibuat bareng tagihannya (alur lama) -- gak bisa direvisi', v_note.source_ref;
  end if;

  perform assert_period_open(p_entry_date);

  select billing_status into v_status from goods_notes_with_billing_status where id = p_goods_note_id;
  if v_status is distinct from 'belum_tertagih' then
    raise exception 'Barang masuk % berstatus % -- revisi cuma boleh selama belum ditagih', v_note.source_ref, v_status;
  end if;

  select account_id into v_grni_account_id
    from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced';
  if v_grni_account_id is null then
    raise exception 'Default Akun "Barang Diterima Belum Ditagih" belum diset';
  end if;

  select count(*) into v_expected_count from goods_note_lines where goods_note_id = p_goods_note_id;
  select count(distinct (e->>'goods_note_line_id')) into v_given_count from jsonb_array_elements(p_lines) as t(e);
  if jsonb_array_length(p_lines) <> v_expected_count or v_given_count <> v_expected_count
     or exists (
       select 1 from jsonb_array_elements(p_lines) as t(e)
       where not exists (
         select 1 from goods_note_lines gnl
         where gnl.id = (e->>'goods_note_line_id')::uuid and gnl.goods_note_id = p_goods_note_id
       )
     ) then
    raise exception 'Revisi wajib menyertakan SEMUA baris barang masuk % (tepat satu kali tiap baris)', v_note.source_ref;
  end if;

  select jsonb_agg(
           jsonb_build_object(
             'qty', gnl.qty,
             'unit_cost', e->>'unit_cost',
             'discount_amount', coalesce(e->>'discount_amount', '0')
           ) order by ord)
    into v_calc
    from jsonb_array_elements(p_lines) with ordinality as t(e, ord)
    join goods_note_lines gnl on gnl.id = (e->>'goods_note_line_id')::uuid;

  v_discounts := grn_prorate_discount(v_calc, p_discount_amount);

  v_idx := 0;
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_idx := v_idx + 1;
    select qty into v_qty from goods_note_lines where id = (v_line->>'goods_note_line_id')::uuid;
    v_value := v_value + round(v_qty * (v_line->>'unit_cost')::numeric, 2) - v_discounts[v_idx];
  end loop;

  select coalesce(max(revision_no), 1) + 1 into v_revision_no from goods_note_revisions where goods_note_id = p_goods_note_id;

  select journal_entry_id into v_current_journal
    from goods_note_revisions where goods_note_id = p_goods_note_id order by revision_no desc limit 1;
  if not found then
    v_current_journal := v_note.journal_entry_id;
  end if;

  if v_current_journal is not null then
    v_reversal_id := reverse_journal_entry(v_current_journal, p_entry_date, v_note.source_ref || '/REV' || v_revision_no);
  end if;

  if v_value > 0 then
    v_new_entry_id := create_journal_entry(
      p_entry_date, 'Revisi barang masuk ' || v_note.source_ref || ' (revisi ' || v_revision_no || ')',
      v_note.source_ref || '/REV' || v_revision_no,
      jsonb_build_array(
        jsonb_build_object('account_id', p_inventory_account_id, 'debit', v_value, 'credit', 0),
        jsonb_build_object('account_id', v_grni_account_id, 'debit', 0, 'credit', v_value)
      )
    );
  end if;

  insert into goods_note_revisions (goods_note_id, revision_no, delivery_note_ref, reversal_journal_entry_id,
                                    journal_entry_id, entry_date, created_by)
  values (p_goods_note_id, v_revision_no, p_delivery_note_ref, v_reversal_id, v_new_entry_id, p_entry_date, auth.uid())
  returning id into v_revision_id;

  v_idx := 0;
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_idx := v_idx + 1;
    insert into goods_note_revision_lines (revision_id, goods_note_line_id, unit_cost, discount_amount)
    values (v_revision_id, (v_line->>'goods_note_line_id')::uuid, (v_line->>'unit_cost')::numeric, v_discounts[v_idx]);
  end loop;

  return v_revision_id;
end;
$$;

grant execute on function revise_goods_receipt(uuid, date, jsonb, uuid, text, numeric) to authenticated;

-- cancel_goods_receipt -- batalkan barang masuk BELUM ditagih: jurnal yang berlaku dibalik, stok dan
-- qty_unbilled dikurangi, mutasi kompensasi ke Kartu Stok. Ditolak kalau salah satu qty-nya sudah
-- terjual lebih dulu (alokasi FIFO) -- barang yang sudah terjual gak bisa dibalik.
create function cancel_goods_receipt(p_goods_note_id uuid, p_entry_date date) returns uuid
language plpgsql
security invoker
as $$
declare
  v_note goods_notes%rowtype;
  v_status text;
  v_current_journal uuid;
  v_reversal_id uuid;
  v_item record;
  v_line record;
  v_spilled numeric;
  v_qty_on_hand numeric;
  v_item_name text;
begin
  perform pg_advisory_xact_lock(hashtext('goods_receipt:' || p_goods_note_id::text));

  select * into v_note from goods_notes where id = p_goods_note_id and type = 'INBOUND';
  if not found then
    raise exception 'Barang masuk % gak ditemukan', p_goods_note_id;
  end if;
  if v_note.inbound_flow is distinct from 'deferred' then
    raise exception 'Barang masuk % dibuat bareng tagihannya (alur lama) -- batalkan lewat tagihannya', v_note.source_ref;
  end if;

  perform assert_period_open(p_entry_date);

  select billing_status into v_status from goods_notes_with_billing_status where id = p_goods_note_id;
  if v_status is distinct from 'belum_tertagih' then
    raise exception 'Barang masuk % berstatus % -- cuma yang belum ditagih yang bisa dibatalkan', v_note.source_ref, v_status;
  end if;

  for v_item in
    select item_id, sum(qty) as qty
    from goods_note_lines where goods_note_id = p_goods_note_id
    group by item_id order by item_id
  loop
    select name into v_item_name from items where id = v_item.item_id;

    select qty_on_hand into v_qty_on_hand
      from inventory_balances where item_id = v_item.item_id for update;
    if not found or v_qty_on_hand < v_item.qty then
      raise exception 'Barang masuk % gak bisa dibatalkan: stok "%" tinggal %, kurang dari qty diterima % (sebagian sudah terpakai/terjual)',
        v_note.source_ref, v_item_name, coalesce(v_qty_on_hand, 0), v_item.qty;
    end if;

    select coalesce(qty_spilled, 0) into v_spilled
      from grni_spill_allocation(v_item.item_id) where goods_note_id = p_goods_note_id;
    if coalesce(v_spilled, 0) > 0.0005 then
      raise exception 'Barang masuk % gak bisa dibatalkan: % dari qty "%" sudah terjual lebih dulu -- tagih lalu pakai Retur AP atau Stock Opname',
        v_note.source_ref, v_spilled, v_item_name;
    end if;

    update inventory_balances
      set qty_on_hand = qty_on_hand - v_item.qty,
          qty_unbilled = qty_unbilled - v_item.qty,
          updated_at = now()
      where item_id = v_item.item_id;
  end loop;

  for v_line in select id, item_id, qty from goods_note_lines where goods_note_id = p_goods_note_id
  loop
    insert into inventory_movements (item_id, movement_date, qty, goods_note_line_id)
    values (v_line.item_id, p_entry_date, -v_line.qty, v_line.id);
  end loop;

  select journal_entry_id into v_current_journal
    from goods_note_revisions where goods_note_id = p_goods_note_id order by revision_no desc limit 1;
  if not found then
    v_current_journal := v_note.journal_entry_id;
  end if;

  if v_current_journal is not null then
    v_reversal_id := reverse_journal_entry(v_current_journal, p_entry_date, v_note.source_ref || '/BTL');
  end if;

  insert into goods_note_cancellations (goods_note_id, journal_entry_id, cancelled_by)
  values (p_goods_note_id, v_reversal_id, auth.uid());

  if v_note.order_id is not null then
    perform recompute_order_status(v_note.order_id);
  end if;

  return v_reversal_id;
end;
$$;

grant execute on function cancel_goods_receipt(uuid, date) to authenticated;

-- ============================================================================================
-- 10. Tagihan dari barang masuk
-- ============================================================================================

-- create_ap_bill_from_goods_receipts -- buat tagihan dari 1+ barang masuk belum ditagih (supplier sama).
-- Jurnal tagihan: Debit Barang Diterima Belum Ditagih (jumlah nilai barang masuk) [+ baris biaya
-- tambahan & PPN seperti tagihan biasa] / Kredit Utang Usaha. Per item: avg_cost, qty_unbilled,
-- spill_value dihitung ulang; selisih unit yang sudah terjual dijurnal sebagai koreksi HPP.
create function create_ap_bill_from_goods_receipts(
  p_goods_note_ids uuid[],
  p_bill_date date,
  p_description text,
  p_source_ref text,
  p_payable_account_id uuid,
  p_extra_debit_lines jsonb default null, -- array of {"account_id":uuid,"amount":numeric} -- biaya tambahan nota
  p_apply_tax boolean default false,
  p_supplier_document_ref text default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_grni_account_id uuid;
  v_hpp_account_id uuid;
  v_ids uuid[];
  v_note record;
  v_supplier_id uuid;
  v_total_value numeric := 0;
  v_debit_lines jsonb;
  v_line jsonb;
  v_bill_id uuid;
  v_item record;
  v_q numeric; v_u numeric; v_avg numeric; v_sv numeric;
  v_p numeric;
  v_s_total numeric;
  v_r numeric; v_a numeric; v_a_value numeric; v_r_value numeric;
  v_avgspill numeric;
  v_delta numeric;
  v_new_avg numeric;
  v_new_u numeric; v_new_sv numeric;
  v_inv_account uuid;
  v_corr_accounts uuid[] := '{}';
  v_corr_deltas numeric[] := '{}';
  v_corr_items uuid[] := '{}';
  v_hpp_entry_id uuid;
  v_hpp_lines jsonb := '[]'::jsonb;
  v_hpp_net numeric := 0;
  v_acct record;
  v_acct_amount numeric;
  v_alloc_rows jsonb := '[]'::jsonb;
  v_row jsonb;
  i int;
begin
  if p_goods_note_ids is null or array_length(p_goods_note_ids, 1) is null then
    raise exception 'Pilih minimal 1 barang masuk yang mau ditagih';
  end if;

  select array_agg(distinct x order by x) into v_ids from unnest(p_goods_note_ids) as x;

  select account_id into v_grni_account_id
    from app_default_account_settings where role_key = 'inventory.goods_received_not_invoiced';
  select account_id into v_hpp_account_id
    from app_default_account_settings where role_key = 'inventory.hpp';
  if v_grni_account_id is null or v_hpp_account_id is null then
    raise exception 'Default Akun "Barang Diterima Belum Ditagih"/"Harga Pokok Penjualan" belum diset -- cek Pengaturan > Default Akun';
  end if;

  -- kunci semua barang masuk yang dipilih (urut id) biar gak ada 2 tagihan bersamaan untuk barang masuk yang sama
  for i in 1..array_length(v_ids, 1) loop
    perform pg_advisory_xact_lock(hashtext('goods_receipt:' || v_ids[i]::text));
  end loop;

  for v_note in
    select id, counterparty_id, source_ref, billing_status, inbound_flow
    from goods_notes_with_billing_status where id = any(v_ids)
  loop
    if v_supplier_id is null then
      v_supplier_id := v_note.counterparty_id;
    elsif v_supplier_id is distinct from v_note.counterparty_id then
      raise exception 'Barang masuk % milik supplier lain -- 1 tagihan cuma boleh menggabungkan barang masuk 1 supplier', v_note.source_ref;
    end if;
    if v_note.inbound_flow <> 'deferred' or v_note.billing_status <> 'belum_tertagih' then
      raise exception 'Barang masuk % berstatus % -- cuma yang belum ditagih yang bisa ditagih', v_note.source_ref, v_note.billing_status;
    end if;
  end loop;

  if (select count(*) from goods_notes_with_billing_status where id = any(v_ids)) <> array_length(v_ids, 1) then
    raise exception 'Ada barang masuk yang gak ditemukan';
  end if;

  if exists (
    select 1 from goods_note_line_current_cost c
    where c.goods_note_id = any(v_ids) and c.line_value <= 0
  ) then
    raise exception 'Ada baris barang masuk berharga 0 -- revisi harganya dulu sebelum ditagih';
  end if;

  select coalesce(sum(line_value), 0) into v_total_value
    from goods_note_line_current_cost where goods_note_id = any(v_ids);

  v_debit_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_grni_account_id, 'amount', v_total_value)
  );
  if p_extra_debit_lines is not null then
    for v_line in select * from jsonb_array_elements(p_extra_debit_lines)
    loop
      v_debit_lines := v_debit_lines || jsonb_build_array(v_line);
    end loop;
  end if;

  v_bill_id := create_transaction(
    'INBOUND', v_supplier_id, p_bill_date, p_description, p_source_ref,
    v_debit_lines, p_payable_account_id, p_apply_tax, p_supplier_document_ref, 0
  );

  -- Per item: hitung dampak ke saldo stok SEBELUM barang masuk ditandai tertagih (alokasi FIFO
  -- dihitung dari daftar barang masuk belum ditagih).
  for v_item in
    select distinct c.item_id from goods_note_line_current_cost c where c.goods_note_id = any(v_ids) order by c.item_id
  loop
    select qty_on_hand, qty_unbilled, avg_cost, spill_value into v_q, v_u, v_avg, v_sv
      from inventory_balances where item_id = v_item.item_id for update;
    if not found then
      raise exception 'Item % gak punya saldo stok -- data gak konsisten', v_item.item_id;
    end if;

    select coalesce(sum(qty_spilled), 0) into v_s_total from grni_spill_allocation(v_item.item_id);

    select coalesce(sum(al.qty_remaining), 0), coalesce(sum(al.qty_spilled), 0),
           coalesce(sum(al.qty_remaining * c.unit_val), 0), coalesce(sum(al.qty_spilled * c.unit_val), 0)
      into v_r, v_a, v_r_value, v_a_value
      from grni_spill_allocation(v_item.item_id) al
      join (
        select goods_note_id, sum(line_value) / sum(qty) as unit_val
        from goods_note_line_current_cost where item_id = v_item.item_id group by goods_note_id
      ) c on c.goods_note_id = al.goods_note_id
      where al.goods_note_id = any(v_ids);

    v_p := v_q - v_u;
    v_avgspill := case when v_s_total > 0.0005 then v_sv / v_s_total else 0 end;
    v_delta := v_a_value - v_a * v_avgspill;

    if v_p + v_r > 0.0005 then
      v_new_avg := round((v_p * v_avg + v_r_value) / (v_p + v_r), 2);
    else
      v_new_avg := v_avg;
    end if;
    v_new_u := v_u - v_r;
    v_new_sv := greatest(0, v_sv - v_a * v_avgspill);

    update inventory_balances
      set avg_cost = v_new_avg, qty_unbilled = v_new_u, spill_value = v_new_sv, updated_at = now()
      where item_id = v_item.item_id;

    -- baris alokasi diinsert SETELAH jurnal koreksi HPP dibuat (tabelnya immutable, gak bisa di-UPDATE)
    v_alloc_rows := v_alloc_rows || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.item_id, 'avg_before', v_avg, 'avg_after', v_new_avg, 'qty_on_hand_after', v_q,
      'unbilled_before', v_u, 'unbilled_after', v_new_u,
      'spill_value_before', v_sv, 'spill_value_after', v_new_sv,
      'qty_remaining', v_r, 'qty_spilled', v_a, 'hpp_correction', round(v_delta, 2)));

    if abs(round(v_delta, 2)) >= 0.01 then
      select inventory_account_id into v_inv_account from items where id = v_item.item_id;
      v_corr_items := v_corr_items || v_item.item_id;
      v_corr_accounts := v_corr_accounts || v_inv_account;
      v_corr_deltas := v_corr_deltas || round(v_delta, 2);
    end if;
  end loop;

  -- Koreksi HPP: delta > 0 -> Debit HPP / Kredit Persediaan; delta < 0 -> kebalikannya (net per akun Persediaan).
  if array_length(v_corr_items, 1) is not null then
    for v_acct in
      select a as account_id, sum(d) as net
      from unnest(v_corr_accounts, v_corr_deltas) as t(a, d)
      group by a
    loop
      v_acct_amount := round(v_acct.net, 2);
      if v_acct_amount > 0 then
        v_hpp_lines := v_hpp_lines || jsonb_build_array(
          jsonb_build_object('account_id', v_acct.account_id, 'debit', 0, 'credit', v_acct_amount));
        v_hpp_net := v_hpp_net + v_acct_amount;
      elsif v_acct_amount < 0 then
        v_hpp_lines := v_hpp_lines || jsonb_build_array(
          jsonb_build_object('account_id', v_acct.account_id, 'debit', -v_acct_amount, 'credit', 0));
        v_hpp_net := v_hpp_net + v_acct_amount;
      end if;
    end loop;

    if v_hpp_net > 0 then
      v_hpp_lines := v_hpp_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_hpp_account_id, 'debit', v_hpp_net, 'credit', 0));
    elsif v_hpp_net < 0 then
      v_hpp_lines := v_hpp_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_hpp_account_id, 'debit', 0, 'credit', -v_hpp_net));
    end if;

    -- net per akun bisa saling menghapus (HPP net 0) -- kalau semua baris 0 gak ada jurnal.
    if jsonb_array_length(v_hpp_lines) >= 2 then
      v_hpp_entry_id := create_journal_entry(
        p_bill_date, 'Koreksi HPP atas barang yang terjual sebelum ditagih (' || p_source_ref || ')',
        p_source_ref || '/HPP', v_hpp_lines);
    end if;
  end if;

  for v_row in select * from jsonb_array_elements(v_alloc_rows)
  loop
    insert into goods_note_billing_allocations (
      transaction_id, item_id, avg_before, avg_after, qty_on_hand_after, unbilled_before, unbilled_after,
      spill_value_before, spill_value_after, qty_remaining, qty_spilled, hpp_correction, hpp_journal_entry_id)
    values (
      v_bill_id, (v_row->>'item_id')::uuid, (v_row->>'avg_before')::numeric, (v_row->>'avg_after')::numeric, (v_row->>'qty_on_hand_after')::numeric,
      (v_row->>'unbilled_before')::numeric, (v_row->>'unbilled_after')::numeric,
      (v_row->>'spill_value_before')::numeric, (v_row->>'spill_value_after')::numeric,
      (v_row->>'qty_remaining')::numeric, (v_row->>'qty_spilled')::numeric, (v_row->>'hpp_correction')::numeric,
      case when (v_row->>'hpp_correction')::numeric <> 0 then v_hpp_entry_id else null end);
  end loop;

  -- Tandai barang masuk tertagih (trigger: validasi supplier/status + hitung ulang status tagihan & PO).
  for i in 1..array_length(v_ids, 1) loop
    insert into goods_note_billings (goods_note_id, transaction_id, created_by)
    values (v_ids[i], v_bill_id, auth.uid());
  end loop;

  return v_bill_id;
end;
$$;

grant execute on function create_ap_bill_from_goods_receipts(uuid[], date, text, text, uuid, jsonb, boolean, text) to authenticated;

-- ============================================================================================
-- 11. Fungsi lama yang harus ikut alur baru
-- ============================================================================================

-- recompute_transaction_status -- sama persis 0015 kecuali asal (origin) tagihan INBOUND dibaca dari
-- goods_note_billings (bukan goods_notes.transaction_id, yang kosong untuk barang masuk alur baru).
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
      when not exists (select 1 from goods_note_billings b where b.transaction_id = p_transaction_id) then 'financial_only'
      when exists (
        select 1 from goods_note_billings b
        join goods_notes gn on gn.id = b.goods_note_id
        where b.transaction_id = p_transaction_id and gn.order_id is not null
      ) then 'order'
      else 'goods_movement'
    end;

    update transactions
      set outstanding = v_outstanding, status = v_status, origin = v_origin
      where id = p_transaction_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

-- recompute_order_status -- sama persis 0052 kecuali "barang masuk/keluar yang berlaku" ditentukan
-- goods_note_is_active (barang masuk alur baru belum punya tagihan, jadi gak bisa di-join ke transactions).
create or replace function recompute_order_status(p_order_id uuid) returns void as $$
declare
  v_direction text;
  v_cancelled_at timestamptz;
  v_all_done boolean;
  v_none_done boolean;
  v_status text;
begin
  select direction, cancelled_at into v_direction, v_cancelled_at from orders where id = p_order_id;
  if not found then
    return;
  end if;

  if v_cancelled_at is not null then
    return;
  end if;

  if v_direction = 'PURCHASE' then
    select
      coalesce(bool_and(coalesce(gr.received, 0) >= ol.qty_ordered - 0.0005), true),
      coalesce(bool_and(coalesce(gr.received, 0) <= 0.0005), true)
      into v_all_done, v_none_done
    from order_lines ol
    left join lateral (
      select sum(gnl.qty) as received
      from goods_note_lines gnl
      where gnl.order_line_id = ol.id and goods_note_is_active(gnl.goods_note_id)
    ) gr on true
    where ol.order_id = p_order_id;

    v_status := case
      when v_all_done then 'FULLY_RECEIVED'
      when v_none_done then 'OPEN'
      else 'PARTIALLY_RECEIVED'
    end;
  else
    select
      coalesce(bool_and(coalesce(gi.issued, 0) >= ol.qty_ordered - 0.0005), true),
      coalesce(bool_and(coalesce(gi.issued, 0) <= 0.0005), true)
      into v_all_done, v_none_done
    from order_lines ol
    left join lateral (
      select sum(gnl.qty) as issued
      from goods_note_lines gnl
      where gnl.order_line_id = ol.id and goods_note_is_active(gnl.goods_note_id)
    ) gi on true
    where ol.order_id = p_order_id;

    v_status := case
      when v_all_done then 'FULLY_FULFILLED'
      when v_none_done then 'OPEN'
      else 'PARTIALLY_FULFILLED'
    end;
  end if;

  update orders set status = v_status where id = p_order_id;
end;
$$ language plpgsql security definer set search_path = public;

-- goods_note_lines_no_over_fulfill -- sama persis 0052 kecuali memakai goods_note_is_active.
create or replace function goods_note_lines_no_over_fulfill() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_fulfilled numeric;
  v_item_name text;
begin
  if new.order_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from order_lines where id = new.order_line_id;
  select coalesce(sum(gnl.qty), 0) into v_qty_fulfilled
    from goods_note_lines gnl
    where gnl.order_line_id = new.order_line_id
      and goods_note_is_active(gnl.goods_note_id);

  if v_qty_fulfilled + new.qty > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Qty item "%" melebihi qty dipesan di order (sisa %, coba %)',
      v_item_name, v_qty_ordered - v_qty_fulfilled, new.qty;
  end if;

  return new;
end;
$$ language plpgsql;

-- cancel_order -- sama persis 0052 kecuali memakai goods_note_is_active.
create or replace function cancel_order(p_order_id uuid) returns void
language plpgsql
security invoker
as $$
declare
  v_direction text;
  v_realized_count int;
begin
  select direction into v_direction from orders where id = p_order_id;
  if not found then
    raise exception 'Order % gak ditemukan', p_order_id;
  end if;

  select count(*) into v_realized_count
  from goods_note_lines gnl
  join order_lines ol on ol.id = gnl.order_line_id
  where ol.order_id = p_order_id
    and goods_note_is_active(gnl.goods_note_id);

  if v_realized_count > 0 then
    if v_direction = 'PURCHASE' then
      raise exception 'Order % udah punya penerimaan barang — gak bisa dibatalkan', p_order_id;
    else
      raise exception 'Order % udah punya pengiriman barang — gak bisa dibatalkan', p_order_id;
    end if;
  end if;

  update orders set cancelled_at = now()
  where id = p_order_id and cancelled_at is null;

  if not found then
    raise exception 'Order % gak ditemukan atau udah dibatalkan', p_order_id;
  end if;
end;
$$;

-- cancel_ap_bill -- versi baru. Tiga jalur dalam 1 RPC:
--   (a) tagihan dari barang masuk alur baru (ada goods_note_billing_allocations): memulihkan avg_cost,
--       qty_unbilled, spill_value ke kondisi sebelum ditagih, membalik jurnal koreksi HPP + jurnal tagihan.
--       Barang masuknya kembali belum_tertagih, stok TIDAK dibalik. Ditolak kalau stok item sudah
--       bergerak sejak tagihan dibuat (pemulihan persis gak mungkin kalau stok sudah bergerak).
--   (b) tagihan dari barang masuk alur lama (bundled): sama seperti 0053 -- stok dibalik, tapi avg_cost
--       dihitung dari stok sudah-ditagih (P), bukan seluruh qty_on_hand.
--   (c) tagihan tanpa barang masuk (financial-only): jurnal dibalik seperti biasa.
create or replace function cancel_ap_bill(
  p_bill_id uuid, p_entry_date date, p_source_ref text
) returns uuid language plpgsql security invoker as $$
declare
  v_allocated_count int; v_return_count int; v_deposit_count int; v_replacement_count int;
  v_original_entry_id uuid; v_new_entry_id uuid; v_bill_ref text; v_bill_created_at timestamptz;
  v_has_goods boolean;
  v_note record; v_line record; v_alloc record; v_hpp record; v_order record;
  v_qty_on_hand numeric; v_qty_unbilled numeric; v_avg_cost numeric; v_spill_value numeric;
  v_pool numeric; v_net_value numeric; v_new_pool numeric; v_new_value numeric; v_item_name text;
begin
  perform pg_advisory_xact_lock(hashtext('cancel_transaction:' || p_bill_id::text));
  select source_ref, journal_entry_id, created_at into v_bill_ref, v_original_entry_id, v_bill_created_at
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

  select exists (select 1 from goods_note_billings where transaction_id = p_bill_id) into v_has_goods;

  if v_has_goods then
    select count(*) into v_deposit_count from deposit_applications where transaction_id = p_bill_id;
    select count(*) into v_replacement_count from replacements where transaction_id = p_bill_id;

    if v_deposit_count > 0 or v_replacement_count > 0 then
      raise exception 'Bill % (barang masuk) udah punya DP/tukar barang -- urus itu dulu sebelum dibatalkan', v_bill_ref;
    end if;

    if exists (select 1 from journal_entries je where je.reverses_entry_id = v_original_entry_id) then
      raise exception 'Bill % udah pernah dibatalkan', v_bill_ref;
    end if;
  end if;

  -- (a) alur baru: pulihkan kondisi stok sebelum ditagih
  for v_alloc in
    select * from goods_note_billing_allocations where transaction_id = p_bill_id order by item_id
  loop
    select name into v_item_name from items where id = v_alloc.item_id;

    -- Pemulihan persis cuma valid kalau saldo item masih SAMA dengan kondisi tepat setelah ditagih
    -- (qty, qty belum ditagih, avg_cost, spill_value) -- artinya stok belum bergerak sejak itu.
    select qty_on_hand, qty_unbilled, avg_cost, spill_value into v_qty_on_hand, v_qty_unbilled, v_avg_cost, v_spill_value
      from inventory_balances where item_id = v_alloc.item_id for update;

    if not found
       or v_qty_on_hand is distinct from v_alloc.qty_on_hand_after
       or v_qty_unbilled is distinct from v_alloc.unbilled_after
       or v_avg_cost is distinct from v_alloc.avg_after
       or v_spill_value is distinct from v_alloc.spill_value_after then
      raise exception 'Bill % gak bisa dibatalkan: stok "%" sudah bergerak sejak ditagih -- pakai Retur AP', v_bill_ref, v_item_name;
    end if;

    update inventory_balances
      set avg_cost = v_alloc.avg_before,
          qty_unbilled = qty_unbilled + v_alloc.qty_remaining,
          spill_value = spill_value + (v_alloc.spill_value_before - v_alloc.spill_value_after),
          updated_at = now()
      where item_id = v_alloc.item_id;
  end loop;

  for v_hpp in
    select distinct hpp_journal_entry_id from goods_note_billing_allocations
    where transaction_id = p_bill_id and hpp_journal_entry_id is not null
  loop
    perform reverse_journal_entry(v_hpp.hpp_journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  -- (b) alur lama: stok dibalik (seperti 0053), avg_cost dari stok sudah-ditagih
  for v_note in
    select gn.id from goods_notes gn
    join goods_note_billings b on b.goods_note_id = gn.id
    where b.transaction_id = p_bill_id and gn.inbound_flow = 'bundled'
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
    select distinct gn.order_id
    from goods_note_billings b join goods_notes gn on gn.id = b.goods_note_id
    where b.transaction_id = p_bill_id and gn.order_id is not null
  loop
    perform recompute_order_status(v_order.order_id);
  end loop;

  return v_new_entry_id;
end;
$$;

-- return_lines_no_over_return_outbound -- retur ke supplier: batas qty = TOTAL qty diterima dari semua
-- barang masuk di tagihan itu (via goods_note_billings), per item. Sebelumnya mengambil 1 barang masuk.
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

  if not exists (select 1 from goods_note_billings where transaction_id = v_bill_id) then
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Bill % gak punya goods receipt -- gak bisa retur stok per item', v_bill_ref;
  end if;

  select coalesce(sum(gnl.qty), 0), count(*) into v_qty_received, v_rows
    from goods_note_billings b
    join goods_note_lines gnl on gnl.goods_note_id = b.goods_note_id
    where b.transaction_id = v_bill_id and gnl.item_id = new.item_id;

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

-- create_ap_return -- sama persis 0019 kecuali cek "bill punya barang masuk" lewat goods_note_billings.
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
  select ap_bill_remaining(p_bill_id) into v_remaining_before;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    if not exists (select 1 from goods_note_billings where transaction_id = p_bill_id) then
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

-- replacement_lines_no_over_claim -- sama persis 0021 kecuali untuk tukar barang ke supplier (barang
-- masuk INBOUND) qty tersedia = total qty di SEMUA barang masuk tagihan itu (via goods_note_billings).
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
    if not exists (select 1 from goods_note_billings where transaction_id = v_transaction_id) then
      select source_ref into v_transaction_ref from transactions where id = v_transaction_id;
      raise exception 'Transaksi % gak punya goods note (financial-only) -- gak bisa ganti/tukar barang', v_transaction_ref;
    end if;

    select coalesce(sum(gnl.qty), 0), count(*) into v_qty_available, v_rows
      from goods_note_billings b
      join goods_note_lines gnl on gnl.goods_note_id = b.goods_note_id
      where b.transaction_id = v_transaction_id and gnl.item_id = new.item_id;

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
