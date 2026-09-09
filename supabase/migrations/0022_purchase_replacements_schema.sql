-- Purchase Replacements (AP). Ref: memory/architecture/data/purchase-replacements-schema.md.
-- Penukaran barang ke supplier sisi AP, "Opsi B" dari 2 jalur resolusi retur (mirror
-- warranty_replacements sisi AR, 0021_warranty_replacements_schema.sql -- 2 tabel fisik
-- terpisah, gak digabung waktu unifikasi AR/AP). Gak pernah nunjuk ke returns -- beda dari
-- warranty_replacements (AR) yang punya return_id nullable-historis. Jurnalnya Debit Persediaan
-- (barang baru) / Kredit Persediaan (barang rusak) -- akun yang sama di 2 baris, net nol,
-- dokumentasi/audit trail doang.
--
-- Opsi A ("kurangi utang" via returns, 0019) dan Opsi B (tukar barang, di sini) saling
-- EKSKLUSIF, dipilih manual. Opsi C (purchase_writeoffs) dicabut total -- barang rusak yang
-- supplier tolak kompensasi dialihkan ke stock_opname generic.
--
-- purchase_returned_qty(bill_id, item_id) SUDAH ADA di 0019_returns_schema.sql (guard qty
-- gabungan Opsi A+B, dipakai trigger di bawah) -- JANGAN didefinisikan ulang di sini.

create table purchase_replacements (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references transactions(id),
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index purchase_replacements_bill_id_idx on purchase_replacements(bill_id);

create table purchase_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_replacement_id uuid not null references purchase_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index purchase_replacement_lines_replacement_id_idx on purchase_replacement_lines(purchase_replacement_id);

-- Composite unique (id, item_id) -- dibutuhkan buat FK komposit
-- inventory_movements(purchase_replacement_line_id, item_id) di 0023_inventory_ledger_schema.sql,
-- pola sama goods_note_lines (0018)/return_lines (0019).
alter table purchase_replacement_lines add constraint purchase_replacement_lines_id_item_id_key unique (id, item_id);

create trigger purchase_replacements_block_edit_delete
  before update or delete on purchase_replacements
  for each row execute function block_edit_delete();

create trigger purchase_replacement_lines_block_edit_delete
  before update or delete on purchase_replacement_lines
  for each row execute function block_edit_delete();

-- purchase_replacement_lines_no_over_return -- cap ke goods_note_lines.qty (bill asli, via
-- goods_notes.transaction_id dengan type='INBOUND') dikurangi purchase_returned_qty(). Body
-- salin PERSIS dari supabase/migrations/0082_goods_notes_repoint.sql (versi terepoint ke
-- goods_notes/goods_note_lines -- VERSI TERBARU, bukan versi 0064 lama yang masih baca
-- goods_receipt_notes/goods_receipt_lines).
create function purchase_replacement_lines_no_over_return() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
  v_bill_ref text;
  v_item_name text;
begin
  select bill_id into v_bill_id from purchase_replacements where id = new.purchase_replacement_id;
  select id into v_grn_id from goods_notes where transaction_id = v_bill_id and type = 'INBOUND';

  if v_grn_id is null then
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Bill % gak punya goods receipt -- gak bisa tukar barang per item', v_bill_ref;
  end if;

  select qty into v_qty_received
    from goods_note_lines where goods_note_id = v_grn_id and item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    select source_ref into v_bill_ref from transactions where id = v_bill_id;
    raise exception 'Item "%" gak ada di goods receipt bill %, gak bisa ditukar', v_item_name, v_bill_ref;
  end if;

  select purchase_returned_qty(v_bill_id, new.item_id) into v_already;

  if v_already + new.qty_replaced > v_qty_received then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Tukar barang item "%" melebihi qty diterima (diterima %, sudah diklaim %, coba tukar %)',
      v_item_name, v_qty_received, v_already, new.qty_replaced;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger purchase_replacement_lines_no_over_return_trigger
  before insert on purchase_replacement_lines
  for each row execute function purchase_replacement_lines_no_over_return();

-- create_purchase_replacement -- konsumsi barang rusak pakai consume_weighted_average (sama
-- dipakai jalur full Opsi A), lalu "terima" barang baru pakai avg_cost identik -- net nol.
-- Body salin PERSIS dari supabase/migrations/0082_goods_notes_repoint.sql (versi terepoint ke
-- goods_notes -- VERSI TERBARU, bukan versi 0046 lama yang masih baca goods_receipt_notes).
create function create_purchase_replacement(
  p_bill_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_inventory_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_grn_id uuid;
  v_replacement_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_line_cost numeric;
  v_unit_cost numeric;
  v_total_cost numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_line_id uuid;
begin
  select id into v_grn_id from goods_notes where transaction_id = p_bill_id and type = 'INBOUND';

  if v_grn_id is null then
    raise exception 'Bill % gak punya goods receipt -- gak bisa tukar barang per item', p_bill_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Tukar barang butuh minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);
    v_unit_cost := v_line_cost / v_qty;

    select qty_on_hand, avg_cost into v_qty_before, v_avg_before
      from inventory_balances where item_id = v_item_id;

    update inventory_balances
      set qty_on_hand = v_qty_before + v_qty,
          avg_cost = (v_qty_before * v_avg_before + v_qty * v_unit_cost) / (v_qty_before + v_qty),
          updated_at = now()
      where item_id = v_item_id;

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Tukar barang rusak dengan barang baik dari supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into purchase_replacements (bill_id, replacement_date, source_ref, journal_entry_id, created_by)
  values (p_bill_id, p_replacement_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_replacement_id;

  for i in 1..array_length(v_line_items, 1) loop
    insert into purchase_replacement_lines (purchase_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
    returning id into v_line_id;

    -- barang rusak KELUAR (dikonsumsi di loop atas)
    insert into inventory_movements (item_id, movement_date, qty, purchase_replacement_line_id)
    values (v_line_items[i], p_replacement_date, -v_line_qtys[i], v_line_id);

    -- barang pengganti MASUK (ditambahkan balik di loop atas, item & qty sama)
    insert into inventory_movements (item_id, movement_date, qty, purchase_replacement_line_id)
    values (v_line_items[i], p_replacement_date, v_line_qtys[i], v_line_id);
  end loop;

  return v_replacement_id;
end;
$$;

alter table purchase_replacements enable row level security;

create policy purchase_replacements_select on purchase_replacements for select using (auth.role() = 'authenticated');
create policy purchase_replacements_insert on purchase_replacements for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

alter table purchase_replacement_lines enable row level security;

create policy purchase_replacement_lines_select on purchase_replacement_lines for select using (auth.role() = 'authenticated');
create policy purchase_replacement_lines_insert on purchase_replacement_lines for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

grant select, insert on purchase_replacements to authenticated;
grant select, insert on purchase_replacement_lines to authenticated;

grant execute on function create_purchase_replacement(uuid, date, text, jsonb, uuid) to authenticated;
