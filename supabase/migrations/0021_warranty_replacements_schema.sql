-- Warranty Replacements (AR). Ref: memory/architecture/data/warranty-replacements-schema.md.
-- Penukaran barang pasca-retur/garansi sisi AR -- mirror purchase_replacements sisi AP
-- (0022_purchase_replacements_schema.sql), tapi 2 tabel fisik terpisah (gak digabung waktu
-- unifikasi AR/AP karena beda tabel, beda arah).
--
-- Customer minta barang pengganti buat item yang udah terjual (lewat goods_issue) -- BUKAN
-- gratis/cuma-cuma (dijurnal HPP/Persediaan), TANPA invoice baru, gak nyentuh Piutang Usaha sama
-- sekali. INDEPENDEN dari returns -- invoice_id rujukan utama (bukan return_id), mirror
-- create_purchase_replacement (AP) yang independen dari awal. sales_returned_qty(invoice_id,
-- item_id) SUDAH ADA di 0019_returns_schema.sql (dipakai jaga qty fisik yang sama gak diklaim
-- dobel lintas retur kredit + ganti barang) -- JANGAN didefinisikan ulang di sini.
--
-- return_id (nullable) dan 4 kolom reversal (discount_reversed_amount dkk) TETAP ada di DDL --
-- bagian struktur final buat baris HISTORIS, walau RPC create_warranty_replacement di file ini
-- gak pernah ngisi kolom-kolom itu (selalu default 0/NULL).

create table warranty_replacements (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references transactions(id),
  return_id uuid references returns(id),
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  discount_reversed_amount numeric(14,2) not null default 0 check (discount_reversed_amount >= 0),
  discount_reversal_journal_entry_id uuid references journal_entries(id),
  return_credit_settled_amount numeric(14,2) not null default 0 check (return_credit_settled_amount >= 0),
  return_credit_settlement_journal_entry_id uuid references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index warranty_replacements_invoice_id_idx on warranty_replacements(invoice_id);

create table warranty_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  warranty_replacement_id uuid not null references warranty_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index warranty_replacement_lines_replacement_id_idx on warranty_replacement_lines(warranty_replacement_id);

-- Composite unique (id, item_id) -- dibutuhkan buat FK komposit
-- inventory_movements(warranty_replacement_line_id, item_id) di 0023_inventory_ledger_schema.sql,
-- pola sama goods_note_lines (0018)/return_lines (0019).
alter table warranty_replacement_lines add constraint warranty_replacement_lines_id_item_id_key unique (id, item_id);

create trigger warranty_replacements_block_edit_delete
  before update or delete on warranty_replacements
  for each row execute function block_edit_delete();

create trigger warranty_replacement_lines_block_edit_delete
  before update or delete on warranty_replacement_lines
  for each row execute function block_edit_delete();

-- warranty_replacement_lines_no_over_replace -- cap ke goods_note_lines.qty (invoice asli, via
-- goods_notes.transaction_id dengan type='OUTBOUND') dikurangi sales_returned_qty(). Body salin
-- PERSIS dari supabase/migrations/0082_goods_notes_repoint.sql (versi terepoint ke
-- goods_notes/goods_note_lines -- versi 0057 original masih baca goods_issues/goods_issue_lines
-- lama yang gak pernah ada di migrations_new).
create function warranty_replacement_lines_no_over_replace() returns trigger as $$
declare
  v_invoice_id uuid;
  v_goods_issue_id uuid;
  v_qty_issued numeric;
  v_already_claimed numeric;
  v_item_name text;
begin
  select wr.invoice_id into v_invoice_id
    from warranty_replacements wr where wr.id = new.warranty_replacement_id;

  select gn.id into v_goods_issue_id from goods_notes gn where gn.transaction_id = v_invoice_id and gn.type = 'OUTBOUND';

  if v_goods_issue_id is null then
    raise exception 'Invoice % gak punya goods issue (financial-only) — gak bisa ganti barang', v_invoice_id;
  end if;

  select gnl.qty into v_qty_issued
    from goods_note_lines gnl
    where gnl.goods_note_id = v_goods_issue_id and gnl.item_id = new.item_id;

  if not found then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Item "%" gak ada di goods_issue invoice %, gak bisa diganti', v_item_name, v_invoice_id;
  end if;

  select sales_returned_qty(v_invoice_id, new.item_id) into v_already_claimed;

  if v_already_claimed + new.qty_replaced > v_qty_issued then
    select name into v_item_name from items where id = new.item_id;
    raise exception 'Penggantian item "%" melebihi qty terjual dikurangi yang udah diklaim (terjual %, udah diklaim lewat retur/ganti barang %, coba ganti %)',
      v_item_name, v_qty_issued, v_already_claimed, new.qty_replaced;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger warranty_replacement_lines_no_over_replace_trigger
  before insert on warranty_replacement_lines
  for each row execute function warranty_replacement_lines_no_over_replace();

-- create_warranty_replacement -- security invoker, reuse create_journal_entry+
-- consume_weighted_average. Body salin PERSIS dari
-- supabase/migrations/0057_ar_warranty_replacement_independent.sql (restrukturisasi independen,
-- bentuk final -- fungsi ini gak pernah nyentuh tabel goods_issues/goods_receipt_notes lama
-- sama sekali, jadi aman disalin apa adanya tanpa perlu repoint 0082).
create function create_warranty_replacement(
  p_invoice_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid
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
  v_total_cost numeric := 0;
  v_entry_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_line_id uuid;
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Penukaran barang butuh minimal 1 baris item';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Penukaran barang pasca-retur/garansi', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into warranty_replacements (id, invoice_id, replacement_date, source_ref, journal_entry_id, created_by)
  values (v_replacement_id, p_invoice_id, p_replacement_date, p_source_ref, v_entry_id, auth.uid());

  for i in 1..array_length(v_line_items, 1) loop
    insert into warranty_replacement_lines (warranty_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i])
    returning id into v_line_id;

    insert into inventory_movements (item_id, movement_date, qty, warranty_replacement_line_id)
    values (v_line_items[i], p_replacement_date, -v_line_qtys[i], v_line_id);
  end loop;

  return v_replacement_id;
end;
$$;

alter table warranty_replacements enable row level security;

create policy warranty_replacements_select on warranty_replacements for select using (auth.role() = 'authenticated');
create policy warranty_replacements_insert on warranty_replacements for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

alter table warranty_replacement_lines enable row level security;

create policy warranty_replacement_lines_select on warranty_replacement_lines for select using (auth.role() = 'authenticated');
create policy warranty_replacement_lines_insert on warranty_replacement_lines for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
);

grant select, insert on warranty_replacements to authenticated;
grant select, insert on warranty_replacement_lines to authenticated;

grant execute on function create_warranty_replacement(uuid, date, text, jsonb, uuid, uuid) to authenticated;
