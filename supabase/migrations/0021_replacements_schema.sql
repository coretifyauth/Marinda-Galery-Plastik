-- Penggantian/Penukaran Barang (replacements). Ref: docs/architecture/replacements-schema.md.
-- Gabungan garansi AR (type='INBOUND', ganti barang customer pasca-retur) + tukar barang AP
-- (type='OUTBOUND', tukar barang cacat ke supplier) -- pola sama returns/return_credits/
-- payments/deposits.
--
-- Movement count beda per arah (bukan disamakan paksa): OUTBOUND selalu 2 movement (barang
-- cacat keluar ke supplier + barang baru masuk -- barang cacat itu tercatat sebagai stok
-- aktif perusahaan), INBOUND selalu 1 movement (cuma barang pengganti keluar ke customer --
-- barang cacat customer TIDAK PERNAH masuk ke inventory_balances). create_replacement()
-- modelnya: 1 langkah "keluar" yang selalu jalan + 1 langkah "masuk" opsional cuma buat
-- OUTBOUND.

create table replacements (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')),
  transaction_id uuid not null references transactions(id),
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index replacements_transaction_id_idx on replacements(transaction_id);

create table replacement_lines (
  id uuid primary key default gen_random_uuid(),
  replacement_id uuid not null references replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index replacement_lines_replacement_id_idx on replacement_lines(replacement_id);

-- Composite unique (id, item_id) -- dibutuhkan buat FK komposit inventory_movements
-- (replacement_line_id, item_id), pola sama goods_note_lines/return_lines.
alter table replacement_lines add constraint replacement_lines_id_item_id_key unique (id, item_id);

create trigger replacements_block_edit_delete
  before update or delete on replacements
  for each row execute function block_edit_delete();

create trigger replacement_lines_block_edit_delete
  before update or delete on replacement_lines
  for each row execute function block_edit_delete();

-- replacement_lines_no_over_claim -- cap ke goods_note_lines.qty (goods note arah LAWAN
-- dari type replacement -- INBOUND replacement mengganti barang yang sudah KELUAR lewat
-- goods_note OUTBOUND, OUTBOUND replacement menukar barang yang sudah MASUK lewat goods_note
-- INBOUND) dikurangi qty yang sudah diklaim gabungan retur+ganti barang
-- (sales_returned_qty/purchase_returned_qty).
create function replacement_lines_no_over_claim() returns trigger as $$
declare
  v_type text;
  v_transaction_id uuid;
  v_goods_note_type text;
  v_goods_note_id uuid;
  v_qty_available numeric;
  v_already_claimed numeric;
  v_item_name text;
  v_transaction_ref text;
begin
  select r.type, r.transaction_id into v_type, v_transaction_id
    from replacements r where r.id = new.replacement_id;

  v_goods_note_type := case when v_type = 'INBOUND' then 'OUTBOUND' else 'INBOUND' end;

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

create trigger replacement_lines_no_over_claim_trigger
  before insert on replacement_lines
  for each row execute function replacement_lines_no_over_claim();

-- create_replacement -- RPC tunggal buat kedua arah. Jurnal dikirim eksplisit oleh caller
-- (INBOUND: debit HPP/kredit Persediaan Barang Jadi, 2 akun beda; OUTBOUND: debit
-- Persediaan/kredit Persediaan, akun yang sama dikirim 2x) -- gak butuh percabangan jurnal
-- sama sekali. Yang bercabang cuma langkah movement: consume+1 movement keluar SELALU
-- jalan, langkah terima balik+1 movement masuk CUMA buat OUTBOUND.
create function create_replacement(
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
  v_qty_before numeric;
  v_avg_before numeric;
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

      select qty_on_hand, avg_cost into v_qty_before, v_avg_before
        from inventory_balances where item_id = v_item_id;

      update inventory_balances
        set qty_on_hand = v_qty_before + v_qty,
            avg_cost = (v_qty_before * v_avg_before + v_qty * v_unit_cost) / (v_qty_before + v_qty),
            updated_at = now()
        where item_id = v_item_id;
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

alter table replacements enable row level security;

create policy replacements_select on replacements for select using (auth.role() = 'authenticated');
create policy replacements_insert on replacements for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

alter table replacement_lines enable row level security;

create policy replacement_lines_select on replacement_lines for select using (auth.role() = 'authenticated');
create policy replacement_lines_insert on replacement_lines for insert with check (
  exists (select 1 from app_user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

grant select, insert on replacements to authenticated;
grant select, insert on replacement_lines to authenticated;

grant execute on function create_replacement(text, uuid, date, text, jsonb, uuid, uuid) to authenticated;
