-- Kerugian Barang Rusak (sisi AP) -- Opsi C, ref memory/scope-debt/kerugian-barang-rusak.md.
-- Supplier NOLAK kompensasi sama sekali (gak kurangin Utang Usaha, gak kirim pengganti) --
-- beda dari Opsi A (create_ap_credit_note, kurangi utang) dan Opsi B (create_purchase_
-- replacement, tukar barang net-nol). Berdiri sendiri sama pola Opsi B, gak lewat
-- ap_credit_notes. Utang Usaha gak pernah kesentuh. Jurnal: Debit Beban Kerugian Barang
-- Rusak / Kredit Persediaan Bahan Baku -- murni kerugian, beda dari Opsi B yang net-nol.
--
-- Partial-capable "gratis": Opsi A/B/C berbagi 1 fungsi guard yang sama (purchase_returned_
-- qty, diperluas jadi 3 sumber), dibatasi qty fisik goods_receipt_lines.qty_received --
-- gak butuh fungsi *_remaining() terpisah kayak ap_deposit_remaining().

create table purchase_writeoffs (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references ap_bills(id),
  writeoff_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index purchase_writeoffs_bill_id_idx on purchase_writeoffs(bill_id);

create trigger purchase_writeoffs_block_edit_delete
  before update or delete on purchase_writeoffs
  for each row execute function block_edit_delete();

create table purchase_writeoff_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_writeoff_id uuid not null references purchase_writeoffs(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_written_off numeric(14,3) not null check (qty_written_off > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index purchase_writeoff_lines_writeoff_id_idx on purchase_writeoff_lines(purchase_writeoff_id);

create trigger purchase_writeoff_lines_block_edit_delete
  before update or delete on purchase_writeoff_lines
  for each row execute function block_edit_delete();

-- purchase_returned_qty diperluas -- sekarang jumlahin 3 sumber (Opsi A + Opsi B + Opsi C),
-- fisiknya cuma ada 1 pool qty_received yang bisa diklaim mau lewat jalur mana pun.
create or replace function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
  select
    coalesce((
      select sum(prl.qty_returned) from purchase_return_lines prl
      join ap_credit_notes acn on acn.id = prl.credit_note_id
      where acn.bill_id = p_bill_id and prl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(prpl.qty_replaced) from purchase_replacement_lines prpl
      join purchase_replacements prp on prp.id = prpl.purchase_replacement_id
      where prp.bill_id = p_bill_id and prpl.item_id = p_item_id
    ), 0)
    +
    coalesce((
      select sum(pwl.qty_written_off) from purchase_writeoff_lines pwl
      join purchase_writeoffs pw on pw.id = pwl.purchase_writeoff_id
      where pw.bill_id = p_bill_id and pwl.item_id = p_item_id
    ), 0);
$$ language sql stable;

create function purchase_writeoff_lines_no_over_return() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
begin
  select bill_id into v_bill_id from purchase_writeoffs where id = new.purchase_writeoff_id;
  select id into v_grn_id from goods_receipt_notes where bill_id = v_bill_id;

  if v_grn_id is null then
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tulis-jadi-beban per item', v_bill_id;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

  if not found then
    raise exception 'Item % gak ada di goods_receipt bill %, gak bisa ditulis-jadi-beban', new.item_id, v_bill_id;
  end if;

  select purchase_returned_qty(v_bill_id, new.item_id) into v_already;

  if v_already + new.qty_written_off > v_qty_received then
    raise exception 'Write-off item % melebihi qty diterima (diterima %, sudah diklaim %, coba write-off %)',
      new.item_id, v_qty_received, v_already, new.qty_written_off;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger purchase_writeoff_lines_no_over_return_trigger
  before insert on purchase_writeoff_lines
  for each row execute function purchase_writeoff_lines_no_over_return();

-- create_purchase_writeoff (Opsi C) -- mirror create_purchase_replacement (Opsi B), bedanya
-- jurnal BUKAN net-nol (Debit Beban Kerugian Barang Rusak / Kredit Persediaan Bahan Baku,
-- 2 akun beda), karena gak ada barang pengganti yang masuk.
create function create_purchase_writeoff(
  p_bill_id uuid,
  p_writeoff_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_loss_expense_account_id uuid,
  p_inventory_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_grn_id uuid;
  v_writeoff_id uuid;
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
begin
  select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

  if v_grn_id is null then
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tulis-jadi-beban per item', p_bill_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Tulis-jadi-beban butuh minimal 1 baris item';
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
    p_writeoff_date, 'Barang rusak ditulis-jadi-beban -- supplier tolak kompensasi', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_loss_expense_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_inventory_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  insert into purchase_writeoffs (bill_id, writeoff_date, source_ref, journal_entry_id, created_by)
  values (p_bill_id, p_writeoff_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_writeoff_id;

  for i in 1..array_length(v_line_items, 1) loop
    insert into purchase_writeoff_lines (purchase_writeoff_id, item_id, qty_written_off, total_cost)
    values (v_writeoff_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_writeoff_id;
end;
$$;

-- RLS -- pola identik purchase_replacements/purchase_replacement_lines: select semua
-- authenticated, insert cuma admin/accountant, gak ada update/delete (RLS default-deny +
-- block_edit_delete).

alter table purchase_writeoffs enable row level security;

create policy purchase_writeoffs_select on purchase_writeoffs
  for select using (auth.role() = 'authenticated');

create policy purchase_writeoffs_insert on purchase_writeoffs
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table purchase_writeoff_lines enable row level security;

create policy purchase_writeoff_lines_select on purchase_writeoff_lines
  for select using (auth.role() = 'authenticated');

create policy purchase_writeoff_lines_insert on purchase_writeoff_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on purchase_writeoffs to authenticated;
grant select, insert on purchase_writeoff_lines to authenticated;
