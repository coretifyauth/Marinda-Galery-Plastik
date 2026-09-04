-- Orders (gabung Purchase Order + Sales Order) -- Fase 3 dari
-- memory/scope-debt/order-generalization.md (keputusan owner, 2026-09-04). Purchase Order dan
-- Sales Order sekarang cuma beda `direction` ('PURCHASE'/'SALE'), bukan 2 tabel/2 RPC terpisah
-- lagi. Baru bisa dikerjakan sekarang karena 2 prasyaratnya udah selesai: Fase 1 (counterparties)
-- bikin `orders.counterparty_id` punya 1 tabel rujukan buat kedua arah, Fase 2 (PO gak wajib)
-- bikin PO dan SO beneran simetris (dua-duanya opsional, dua-duanya bebas tipe item).
--
-- Yang TETAP terpisah (gak ikut digabung): layer fulfillment + finansial di bawahnya --
-- create_goods_receipt (arah PURCHASE) dan create_goods_issue (arah SALE) tetap 2 RPC beda
-- total, karena efek jurnalnya beneran beda (1 sisi cuma update Persediaan, sisi lain bikin 2
-- jurnal Piutang+HPP). goods_receipt_notes.order_id cuma boleh nunjuk order PURCHASE,
-- goods_issue_lines.order_line_id cuma boleh nunjuk baris order SALE -- dijaga trigger sendiri
-- (bagian 6), gak bisa dijamin FK biasa.
--
-- Beda dari rencana awal di order-generalization.md: view status TETAP 2 (purchase_orders_
-- with_status/sales_orders_with_status, difilter direction), bukan digabung jadi 1
-- orders_with_status -- biar queries.ts existing (apps/erp/src/lib/purchase-orders|sales-orders/
-- queries.ts) tetap query FROM yang sama, cuma nama kolom yang berubah. List page Purchase
-- Orders/Sales Orders juga TETAP 2 halaman terpisah -- keputusan UI, bukan keharusan DB.

-- ============================================================
-- 1. Tabel baru: orders + order_lines
-- ============================================================

create table orders (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references counterparties(id),
  direction text not null check (direction in ('PURCHASE','SALE')),
  order_date date not null,
  expected_date date,
  source_ref text not null,
  cancelled_at timestamptz,
  status text not null default 'OPEN',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index orders_counterparty_id_idx on orders(counterparty_id);
create index orders_direction_idx on orders(direction);
create index orders_order_date_idx on orders(order_date desc);
create index orders_status_idx on orders(status);

create table order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_ordered numeric(14,3) not null check (qty_ordered > 0),
  unit_price numeric(14,2) not null check (unit_price > 0)
);

create index order_lines_order_id_idx on order_lines(order_id);
create index order_lines_item_id_idx on order_lines(item_id);

-- ============================================================
-- 2. Type-safety (direction <-> role counterparty, pola counterparty_role_guard 0059) +
--    immutability (pola purchase_orders_block_edit_delete_or_cancel 0024, digabung 1 fungsi
--    buat kedua arah karena aturan freeze-nya sama persis -- cuma nama kolom beda).
-- ============================================================

create function orders_counterparty_direction_guard() returns trigger as $$
declare
  v_required_role text;
begin
  v_required_role := case new.direction when 'PURCHASE' then 'supplier' when 'SALE' then 'customer' end;

  if not exists (
    select 1 from counterparty_type_mapping
    where counterparty_id = new.counterparty_id and role = v_required_role
  ) then
    raise exception 'Pihak % bukan % terdaftar -- gak bisa dipakai di order direction %',
      new.counterparty_id, v_required_role, new.direction;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger orders_counterparty_direction_guard_trigger
  before insert on orders
  for each row execute function orders_counterparty_direction_guard();

create function orders_block_edit_delete_or_cancel() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Order gak pernah bisa dihapus';
  end if;

  if old.cancelled_at is not null then
    raise exception 'Order % udah dibatalkan, gak bisa diubah lagi', old.id;
  end if;

  if (old.counterparty_id, old.direction, old.order_date, old.expected_date, old.source_ref,
      old.created_by, old.created_at)
     is distinct from
     (new.counterparty_id, new.direction, new.order_date, new.expected_date, new.source_ref,
      new.created_by, new.created_at) then
    raise exception 'orders immutable kecuali cancelled_at/status';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger orders_block_edit_delete
  before update or delete on orders
  for each row execute function orders_block_edit_delete_or_cancel();

-- cancelled_at menang duluan di CASE status apa pun kondisi qty-nya -- set langsung, gak perlu
-- recompute_order_status ulang (sama pola purchase_orders_sync_status_on_cancel 0053).
create function orders_sync_status_on_cancel() returns trigger as $$
begin
  if new.cancelled_at is not null and old.cancelled_at is null then
    new.status := 'CANCELLED';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger orders_sync_status_on_cancel_trigger
  before update on orders
  for each row execute function orders_sync_status_on_cancel();

create trigger order_lines_block_edit_delete
  before update or delete on order_lines
  for each row execute function block_edit_delete();

-- ============================================================
-- 3. RLS + grant -- mirror persis pola purchase_orders/sales_orders/lines (0004, 0024)
-- ============================================================

alter table orders enable row level security;

create policy orders_select on orders
  for select using (auth.role() = 'authenticated');

create policy orders_insert on orders
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy orders_update on orders
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  ) with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert, update on orders to authenticated;

alter table order_lines enable row level security;

create policy order_lines_select on order_lines
  for select using (auth.role() = 'authenticated');

create policy order_lines_insert on order_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on order_lines to authenticated;

-- ============================================================
-- 4. Backfill -- ID DIPERTAHANKAN sama persis dari purchase_orders/sales_orders/
--    purchase_order_lines/sales_order_lines (pola sama migration 0059 buat counterparties):
--    goods_receipt_lines/goods_issue_lines yang nunjuk balik ke baris ini cukup di-repoint
--    constraint-nya di bagian 5, gak perlu backfill per-baris. status/cancelled_at disalin
--    LANGSUNG dari kolom yang udah kehitung (0053), bukan direcompute ulang -- recompute
--    trigger baru sengaja BELUM ada di titik ini (dibuat belakangan di bagian 8), biar gak
--    kepanggil buat baris lama sebelum goods_receipt_lines/goods_issue_lines selesai
--    di-repoint ke order_line_id.
-- ============================================================

insert into orders (id, counterparty_id, direction, order_date, expected_date, source_ref,
                     cancelled_at, status, created_by, created_at)
select id, supplier_id, 'PURCHASE', po_date, expected_date, source_ref,
       cancelled_at, status, created_by, created_at
from purchase_orders;

insert into orders (id, counterparty_id, direction, order_date, expected_date, source_ref,
                     cancelled_at, status, created_by, created_at)
select id, customer_id, 'SALE', so_date, expected_date, source_ref,
       cancelled_at, status, created_by, created_at
from sales_orders;

insert into order_lines (id, order_id, item_id, qty_ordered, unit_price)
select id, purchase_order_id, item_id, qty_ordered, unit_cost_expected
from purchase_order_lines;

insert into order_lines (id, order_id, item_id, qty_ordered, unit_price)
select id, sales_order_id, item_id, qty_ordered, unit_price
from sales_order_lines;

-- ============================================================
-- 5. Rename + repoint FK goods_receipt_notes/goods_receipt_lines/goods_issue_lines --
--    _repoint_fk generalisasi dari _repoint_fk_to_counterparties (0059): introspeksi
--    pg_constraint/pg_attribute buat nemu nama constraint FK asli (gak bisa ditebak dari
--    konvensi penamaan default), bukan cuma buat target counterparties tapi target apa pun.
-- ============================================================

create function _repoint_fk(p_table regclass, p_column name, p_new_target regclass,
                             p_new_target_column name default 'id')
returns void
language plpgsql
security invoker
as $$
declare
  v_old_conname text;
  v_new_conname text;
begin
  select conname into v_old_conname
    from pg_constraint
    where conrelid = p_table and contype = 'f'
      and conkey = (
        select array_agg(attnum) from pg_attribute
        where attrelid = p_table and attname = p_column
      );

  if v_old_conname is not null then
    execute format('alter table %s drop constraint %I', p_table, v_old_conname);
  end if;

  v_new_conname := p_table::text || '_' || p_column || '_fkey';
  execute format('alter table %s add constraint %I foreign key (%I) references %s (%I)',
    p_table, v_new_conname, p_column, p_new_target, p_new_target_column);
end;
$$;

alter table goods_receipt_notes rename column purchase_order_id to order_id;
select _repoint_fk('goods_receipt_notes', 'order_id', 'orders');
alter index goods_receipt_notes_po_id_idx rename to goods_receipt_notes_order_id_idx;

alter table goods_receipt_lines rename column po_line_id to order_line_id;
select _repoint_fk('goods_receipt_lines', 'order_line_id', 'order_lines');
alter index goods_receipt_lines_po_line_id_idx rename to goods_receipt_lines_order_line_id_idx;

alter table goods_issue_lines rename column so_line_id to order_line_id;
select _repoint_fk('goods_issue_lines', 'order_line_id', 'order_lines');
alter index goods_issue_lines_so_line_id_idx rename to goods_issue_lines_order_line_id_idx;

drop function _repoint_fk(regclass, name, regclass, name);

-- ============================================================
-- 6. Direction-match guard -- goods_receipt_notes.order_id cuma boleh nunjuk order PURCHASE,
--    goods_issue_lines.order_line_id cuma boleh nunjuk baris order SALE. NULL tetap diizinkan
--    lolos (kolom nullable sejak Fase 2 / sejak awal).
-- ============================================================

create function goods_receipt_notes_order_direction_guard() returns trigger as $$
begin
  if new.order_id is null then
    return new;
  end if;

  if not exists (select 1 from orders where id = new.order_id and direction = 'PURCHASE') then
    raise exception 'Order % bukan Purchase Order -- gak bisa dipakai di goods receipt', new.order_id;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_receipt_notes_order_direction_guard_trigger
  before insert on goods_receipt_notes
  for each row execute function goods_receipt_notes_order_direction_guard();

create function goods_issue_lines_order_direction_guard() returns trigger as $$
begin
  if new.order_line_id is null then
    return new;
  end if;

  if not exists (
    select 1 from order_lines ol join orders o on o.id = ol.order_id
    where ol.id = new.order_line_id and o.direction = 'SALE'
  ) then
    raise exception 'Baris order % bukan dari Sales Order -- gak bisa dipakai di goods issue', new.order_line_id;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger goods_issue_lines_order_direction_guard_trigger
  before insert on goods_issue_lines
  for each row execute function goods_issue_lines_order_direction_guard();

-- ============================================================
-- 7. Rewrite guard qty (no-over-receipt/no-over-issue) buat kolom order_line_id/order_lines --
--    signature trigger function gak berubah, aman create or replace langsung.
-- ============================================================

create or replace function goods_receipt_lines_no_over_receipt() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_received numeric;
  v_item_name text;
begin
  if new.order_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from order_lines where id = new.order_line_id;
  select coalesce(sum(qty_received), 0) into v_qty_received
    from goods_receipt_lines where order_line_id = new.order_line_id;

  if v_qty_received + new.qty_received > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Penerimaan item "%" melebihi qty dipesan (sisa %, coba terima %)',
      v_item_name, v_qty_ordered - v_qty_received, new.qty_received;
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function goods_issue_lines_no_over_issue() returns trigger as $$
declare
  v_qty_ordered numeric;
  v_qty_issued numeric;
  v_item_name text;
begin
  if new.order_line_id is null then
    return new;
  end if;

  select qty_ordered into v_qty_ordered from order_lines where id = new.order_line_id;
  select coalesce(sum(qty_issued), 0) into v_qty_issued
    from goods_issue_lines where order_line_id = new.order_line_id;

  if v_qty_issued + new.qty_issued > v_qty_ordered then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Pengiriman item "%" melebihi qty dipesan di Sales Order (sisa %, coba kirim %)',
      v_item_name, v_qty_ordered - v_qty_issued, new.qty_issued;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- 8. Status sync -- recompute_order_status gabungan recompute_purchase_order_status +
--    recompute_sales_order_status (0053), branch di dalam 1 fungsi berdasar direction karena
--    "sumber realisasi" beda (goods_receipt_lines vs goods_issue_lines) walau formula CASE-nya
--    identik. Trigger AFTER INSERT-nya BARU dibuat di sini (setelah backfill bagian 4), lihat
--    catatan di bagian 4.
--
--    goods_receipt_lines_sync_po_status_trigger/goods_issue_lines_sync_so_status_trigger (0053)
--    didrop dulu -- keduanya nempel di tabel yang TETAP ADA (goods_receipt_lines/
--    goods_issue_lines, bukan ikut kedrop otomatis pas purchase_orders/sales_orders didrop di
--    bagian 12) dan bodinya masih nunjuk sales_order_lines/purchase_order_lines yang bakal
--    hilang.
-- ============================================================

drop trigger goods_receipt_lines_sync_po_status_trigger on goods_receipt_lines;
drop function goods_receipt_lines_sync_po_status();
drop trigger goods_issue_lines_sync_so_status_trigger on goods_issue_lines;
drop function goods_issue_lines_sync_so_status();

create function recompute_order_status(p_order_id uuid) returns void as $$
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

  -- orders_block_edit_delete_or_cancel (bagian 2) nolak SEMUA update begitu cancelled_at
  -- kepasang -- order yang udah dibatalkan gak boleh kena UPDATE apa pun lagi, termasuk dari
  -- fungsi ini. Statusnya udah pasti 'CANCELLED' (di-set orders_sync_status_on_cancel), aman skip.
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
      select sum(grl.qty_received) as received
      from goods_receipt_lines grl
      where grl.order_line_id = ol.id
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
      select sum(gil.qty_issued) as issued
      from goods_issue_lines gil
      where gil.order_line_id = ol.id
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

create function order_lines_sync_order_status() returns trigger as $$
begin
  perform recompute_order_status(new.order_id);
  return new;
end;
$$ language plpgsql;

create trigger order_lines_sync_order_status_trigger
  after insert on order_lines
  for each row execute function order_lines_sync_order_status();

create function goods_receipt_lines_sync_order_status() returns trigger as $$
declare
  v_order_id uuid;
begin
  if new.order_line_id is null then
    return new;
  end if;
  select order_id into v_order_id from order_lines where id = new.order_line_id;
  if v_order_id is not null then
    perform recompute_order_status(v_order_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_receipt_lines_sync_order_status_trigger
  after insert on goods_receipt_lines
  for each row execute function goods_receipt_lines_sync_order_status();

create function goods_issue_lines_sync_order_status() returns trigger as $$
declare
  v_order_id uuid;
begin
  if new.order_line_id is null then
    return new;
  end if;
  select order_id into v_order_id from order_lines where id = new.order_line_id;
  if v_order_id is not null then
    perform recompute_order_status(v_order_id);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger goods_issue_lines_sync_order_status_trigger
  after insert on goods_issue_lines
  for each row execute function goods_issue_lines_sync_order_status();

-- ============================================================
-- 9. recompute_ar_invoice_status (0053) -- origin CASE ganti gil.so_line_id -> gil.
--    order_line_id, sisanya byte-identical. Signature gak berubah, aman create or replace.
-- ============================================================

create or replace function recompute_ar_invoice_status(p_invoice_id uuid) returns void as $$
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
      where gi.invoice_id = p_invoice_id and gil.order_line_id is not null
    ) then 'sales_order'
    else 'goods_issue'
  end;

  update ar_invoices
    set outstanding = v_outstanding, returned = v_returned, status = v_status, origin = v_origin
    where id = p_invoice_id;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================
-- 10. RPC create_order / cancel_order -- gantiin create_purchase_order+create_sales_order,
--     cancel_purchase_order+cancel_sales_order. p_direction nentuin role counterparty yang
--     divalidasi orders_counterparty_direction_guard (bagian 2).
-- ============================================================

create function create_order(
  p_direction text,
  p_counterparty_id uuid,
  p_order_date date,
  p_expected_date date,
  p_source_ref text,
  p_lines jsonb -- array of {"item_id":uuid,"qty_ordered":numeric,"unit_price":numeric}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_order_id uuid;
  v_line jsonb;
begin
  if p_direction not in ('PURCHASE','SALE') then
    raise exception 'p_direction harus PURCHASE atau SALE, dapat %', p_direction;
  end if;

  insert into orders (counterparty_id, direction, order_date, expected_date, source_ref, created_by)
  values (p_counterparty_id, p_direction, p_order_date, p_expected_date, p_source_ref, auth.uid())
  returning id into v_order_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into order_lines (order_id, item_id, qty_ordered, unit_price)
    values (
      v_order_id,
      (v_line->>'item_id')::uuid,
      (v_line->>'qty_ordered')::numeric,
      (v_line->>'unit_price')::numeric
    );
  end loop;

  return v_order_id;
end;
$$;

create function cancel_order(p_order_id uuid) returns void
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

  if v_direction = 'PURCHASE' then
    select count(*) into v_realized_count
    from goods_receipt_lines grl
    join order_lines ol on ol.id = grl.order_line_id
    where ol.order_id = p_order_id;

    if v_realized_count > 0 then
      raise exception 'Order % udah punya penerimaan barang — gak bisa dibatalkan', p_order_id;
    end if;
  else
    select count(*) into v_realized_count
    from goods_issue_lines gil
    join order_lines ol on ol.id = gil.order_line_id
    where ol.order_id = p_order_id;

    if v_realized_count > 0 then
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

grant execute on function create_order(text, uuid, date, date, text, jsonb) to authenticated;
grant execute on function cancel_order(uuid) to authenticated;

drop function create_purchase_order(uuid, date, date, text, jsonb);
drop function create_sales_order(uuid, date, date, text, jsonb);
drop function cancel_purchase_order(uuid);
drop function cancel_sales_order(uuid);

-- ============================================================
-- 11. create_goods_receipt / create_goods_issue -- rewrite body buat orders/order_lines.
--     create_goods_receipt: param p_purchase_order_id -> p_order_id. Postgres TERNYATA nolak
--     CREATE OR REPLACE buat rename nama parameter walau tipe/urutan/jumlah sama persis
--     ("cannot change name of input parameter", SQLSTATE 42P13) -- keliru diasumsikan aman di
--     draft awal migration ini (baru ketauan pas percobaan apply pertama gagal). WAJIB drop
--     dulu, sama kayak pelajaran signature-change lain di project ini (0011/0012/0057/0058).
--     create_goods_issue: param list-nya SENDIRI gak berubah sama sekali (p_lines tetap jsonb,
--     so_line_id di dalamnya cuma key jsonb, bukan bagian signature) -- cuma body yang
--     berubah, aman create or replace tanpa drop.
-- ============================================================

drop function create_goods_receipt(uuid, date, text, jsonb, text, text, uuid, uuid, jsonb, boolean, uuid);

create function create_goods_receipt(
  p_order_id uuid,
  p_receipt_date date,
  p_delivery_note_ref text,
  p_lines jsonb, -- array of {"order_line_id":uuid|null,"item_id":uuid,"qty_received":numeric,"unit_cost":numeric}
  p_bill_description text,
  p_bill_source_ref text,
  p_debit_account_id uuid,
  p_payable_account_id uuid,
  p_extra_debit_lines jsonb default null,
  p_apply_tax boolean default false,
  p_supplier_id uuid default null -- wajib diisi kalau p_order_id NULL (terima barang langsung)
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_supplier_id uuid;
  v_line jsonb;
  v_total_amount numeric := 0;
  v_bill_id uuid;
  v_grn_id uuid;
  v_item_id uuid;
  v_qty_received numeric;
  v_unit_cost numeric;
  v_qty_before numeric;
  v_avg_before numeric;
  v_debit_lines jsonb;
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

    if not exists (select 1 from suppliers where id = p_supplier_id) then
      raise exception 'Supplier % gak ditemukan', p_supplier_id;
    end if;

    v_supplier_id := p_supplier_id;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_total_amount := v_total_amount + (v_line->>'qty_received')::numeric * (v_line->>'unit_cost')::numeric;
  end loop;

  v_debit_lines := jsonb_build_array(jsonb_build_object('account_id', p_debit_account_id, 'amount', v_total_amount));
  if p_extra_debit_lines is not null then
    for v_line in select * from jsonb_array_elements(p_extra_debit_lines)
    loop
      v_debit_lines := v_debit_lines || jsonb_build_array(v_line);
    end loop;
  end if;

  v_bill_id := create_ap_bill(
    v_supplier_id, p_receipt_date, p_bill_description, p_bill_source_ref,
    v_debit_lines,
    p_payable_account_id,
    p_apply_tax
  );

  insert into goods_receipt_notes (order_id, bill_id, delivery_note_ref, receipt_date, created_by)
  values (p_order_id, v_bill_id, p_delivery_note_ref, p_receipt_date, auth.uid())
  returning id into v_grn_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty_received := (v_line->>'qty_received')::numeric;
    v_unit_cost := (v_line->>'unit_cost')::numeric;

    insert into goods_receipt_lines (grn_id, order_line_id, item_id, qty_received, unit_cost)
    values (v_grn_id, nullif(v_line->>'order_line_id', '')::uuid, v_item_id, v_qty_received, v_unit_cost)
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, goods_receipt_line_id)
    values (v_item_id, p_receipt_date, v_qty_received, v_line_id);

    select qty_on_hand, avg_cost into v_qty_before, v_avg_before
      from inventory_balances where item_id = v_item_id;

    if not found then
      insert into inventory_balances (item_id, qty_on_hand, avg_cost)
      values (v_item_id, v_qty_received, v_unit_cost);
    else
      update inventory_balances
        set qty_on_hand = v_qty_before + v_qty_received,
            avg_cost = (v_qty_before * v_avg_before + v_qty_received * v_unit_cost) / (v_qty_before + v_qty_received),
            updated_at = now()
        where item_id = v_item_id;
    end if;
  end loop;

  return v_grn_id;
end;
$$;

create or replace function create_goods_issue(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb,
  p_receivable_account_id uuid,
  p_lines jsonb, -- array of {"item_id":uuid,"qty_issued":numeric,"order_line_id":uuid|null}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_issue_id uuid := gen_random_uuid();
  v_invoice_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_order_line_id uuid;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_order_lines uuid[] := '{}';
  i int;
begin
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as l
    join order_lines ol on ol.id = nullif(l->>'order_line_id', '')::uuid
    join orders o on o.id = ol.order_id
    where o.cancelled_at is not null
  ) then
    raise exception 'Salah satu baris menunjuk sales order yang udah dibatalkan';
  end if;

  v_invoice_id := create_ar_invoice(
    p_customer_id, p_invoice_date, p_description, p_source_ref,
    p_credit_lines, p_receivable_account_id, p_apply_tax
  );

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty_issued')::numeric;
    v_order_line_id := nullif(v_line->>'order_line_id', '')::uuid;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_line_order_lines := array_append(v_line_order_lines, v_order_line_id);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_invoice_date, 'HPP ' || p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into goods_issues (id, invoice_id, journal_entry_id, issue_date, source_ref, created_by)
  values (v_issue_id, v_invoice_id, v_entry_id, p_invoice_date, p_source_ref, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into goods_issue_lines (goods_issue_id, item_id, qty_issued, total_cost, order_line_id)
    values (v_issue_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_order_lines[i]);
  end loop;

  return v_issue_id;
end;
$$;

-- ============================================================
-- 12. Drop tabel lama -- trigger/index/policy bawaannya ikut kedrop otomatis (DROP TABLE
--     ngedrop trigger OBJECT yang nempel di situ). Fungsi trigger-nya sendiri (standalone,
--     gak "dimiliki" tabelnya) TETAP ada dan bakal jadi dead code yang nunjuk tabel yang udah
--     gak ada -- didrop eksplisit di sini biar gak nyampah (recompute_purchase_order_status
--     dkk dari 0053, sudah digantikan recompute_order_status di bagian 8). View status lama
--     didrop eksplisit dulu (bagian 13 gantiin dengan versi baru).
-- ============================================================

drop view purchase_orders_with_status;
drop view sales_orders_with_status;

-- Tabel dulu (ngedrop trigger OBJECT yang masih nempel di purchase_order_lines/purchase_orders/
-- sales_order_lines/sales_orders), baru fungsi standalone-nya -- kebalik urutannya bakal kena
-- "cannot drop function ... because other objects depend on it" (trigger masih nunjuk fungsi
-- selama tabelnya belum didrop).
drop table purchase_order_lines;
drop table purchase_orders;
drop table sales_order_lines;
drop table sales_orders;

drop function recompute_purchase_order_status(uuid);
drop function purchase_order_lines_sync_po_status();
drop function purchase_orders_sync_status_on_cancel();
drop function recompute_sales_order_status(uuid);
drop function sales_order_lines_sync_so_status();
drop function sales_orders_sync_status_on_cancel();

-- ============================================================
-- 13. View status baru -- 2 view terfilter direction di atas 1 tabel orders (lihat catatan
--     "Beda dari rencana awal" di kepala file ini).
-- ============================================================

create view purchase_orders_with_status
  with (security_invoker = true) as
select id, counterparty_id, direction, order_date, expected_date, source_ref, created_at,
       cancelled_at, status
from orders
where direction = 'PURCHASE';

create view sales_orders_with_status
  with (security_invoker = true) as
select id, counterparty_id, direction, order_date, expected_date, source_ref, created_at,
       cancelled_at, status
from orders
where direction = 'SALE';

grant select on purchase_orders_with_status to authenticated;
grant select on sales_orders_with_status to authenticated;
