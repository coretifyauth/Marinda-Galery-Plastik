-- Orders (Purchase Order + Sales Order, digabung). Ref: memory/architecture/data/orders-schema.md.

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

-- recompute_order_status -- versi FINAL pasca goods_notes (migration 0082_goods_notes_repoint.sql),
-- baca goods_note_lines langsung (bukan lagi goods_receipt_lines/goods_issue_lines terpisah).
-- goods_notes/goods_note_lines sendiri baru didefinisikan di 0018_goods_notes_schema.sql --
-- aman, PL/pgSQL resolve referensi function lain secara lazy (cuma divalidasi saat dipanggil).
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
      where gnl.order_line_id = ol.id
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
      where gnl.order_line_id = ol.id
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

-- create_order/cancel_order -- versi FINAL (cancel_order repoint goods_note_lines,
-- migration 0082_goods_notes_repoint.sql section 14).
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
    from goods_note_lines gnl
    join order_lines ol on ol.id = gnl.order_line_id
    where ol.order_id = p_order_id;

    if v_realized_count > 0 then
      raise exception 'Order % udah punya penerimaan barang — gak bisa dibatalkan', p_order_id;
    end if;
  else
    select count(*) into v_realized_count
    from goods_note_lines gnl
    join order_lines ol on ol.id = gnl.order_line_id
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

-- View status -- 2 view terfilter direction di atas 1 tabel orders (deviasi sengaja,
-- queries.ts existing gak perlu berubah nama kolom).
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
