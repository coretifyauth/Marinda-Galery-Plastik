-- Accounts Payable schema.
-- Konsolidasi dari migration historis 0010 + 0035 — lihat git log untuk riwayat evolusi.
-- Ref: docs/architecture/ap-schema.md
--
-- Beda desain dari AR (lihat 0005_ar_schema.sql): AP TIDAK mengikuti perubahan strict-1:1
-- payment atau larangan titip-saldo-kredit-retur yang baru diterapkan di AR (0040/0041) —
-- AP masih pakai alokasi payment many-to-many (ap_payment_allocations) dan retur yang bisa
-- dititip ke bill lain (ap_return_credit_applications), sengaja tidak diubah di sesi ini.

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null default 14 check (payment_term_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger suppliers_set_updated_at
  before update on suppliers
  for each row execute function set_updated_at();

create table ap_bills (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  bill_date date not null,
  due_date date not null,
  description text,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_bills_supplier_id_idx on ap_bills(supplier_id);
create index ap_bills_journal_entry_id_idx on ap_bills(journal_entry_id);

create trigger ap_bills_block_edit_delete
  before update or delete on ap_bills
  for each row execute function block_edit_delete();

create table ap_payments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_payments_supplier_id_idx on ap_payments(supplier_id);

create trigger ap_payments_block_edit_delete
  before update or delete on ap_payments
  for each row execute function block_edit_delete();

create table ap_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references ap_payments(id) on delete cascade,
  bill_id uuid not null references ap_bills(id),
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index ap_payment_allocations_payment_id_idx on ap_payment_allocations(payment_id);
create index ap_payment_allocations_bill_id_idx on ap_payment_allocations(bill_id);

create trigger ap_payment_allocations_block_edit_delete
  before update or delete on ap_payment_allocations
  for each row execute function block_edit_delete();

-- ============================================================
-- ap_credit_notes (Opsi A — kurangi Utang Usaha) + purchase_return_lines (rincian item,
-- cuma kalau bill full/item-tracked)
-- ============================================================

create table ap_credit_notes (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references ap_bills(id),
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_credit_notes_bill_id_idx on ap_credit_notes(bill_id);
create index ap_credit_notes_journal_entry_id_idx on ap_credit_notes(journal_entry_id);

create trigger ap_credit_notes_block_edit_delete
  before update or delete on ap_credit_notes
  for each row execute function block_edit_delete();

-- No-over-return (level Rp, terhadap nilai bill) — cap-nya ke ap_bills.amount, BUKAN sisa
-- outstanding, karena retur independen dari status bayar.
create function ap_credit_notes_no_over_return() returns trigger as $$
declare
  v_bill_amount numeric;
  v_already_returned numeric;
begin
  select amount into v_bill_amount from ap_bills where id = new.bill_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from ap_credit_notes where bill_id = new.bill_id;

  if v_already_returned + new.amount > v_bill_amount then
    raise exception 'Retur bill % melebihi nilai bill (bill %, sudah diretur %, coba retur %)',
      new.bill_id, v_bill_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_credit_notes_no_over_return_trigger
  before insert on ap_credit_notes
  for each row execute function ap_credit_notes_no_over_return();

create table purchase_return_lines (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ap_credit_notes(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index purchase_return_lines_credit_note_id_idx on purchase_return_lines(credit_note_id);

create trigger purchase_return_lines_block_edit_delete
  before update or delete on purchase_return_lines
  for each row execute function block_edit_delete();

-- ============================================================
-- purchase_replacements + purchase_replacement_lines (Opsi B — tukar barang, BERDIRI
-- SENDIRI, gak lewat ap_credit_notes sama sekali, Utang Usaha gak pernah kesentuh)
-- ============================================================

create table purchase_replacements (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references ap_bills(id),
  replacement_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index purchase_replacements_bill_id_idx on purchase_replacements(bill_id);

create trigger purchase_replacements_block_edit_delete
  before update or delete on purchase_replacements
  for each row execute function block_edit_delete();

create table purchase_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_replacement_id uuid not null references purchase_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index purchase_replacement_lines_replacement_id_idx on purchase_replacement_lines(purchase_replacement_id);

create trigger purchase_replacement_lines_block_edit_delete
  before update or delete on purchase_replacement_lines
  for each row execute function block_edit_delete();

-- Total qty yang udah "diklaim" dari 1 item di 1 bill, GABUNGAN Opsi A (purchase_return_lines)
-- + Opsi B (purchase_replacement_lines) — fisiknya cuma ada 1 pool qty_received yang bisa
-- diklaim, mau lewat jalur mana pun, gak boleh kelebihan gabungan keduanya.
create function purchase_returned_qty(p_bill_id uuid, p_item_id uuid) returns numeric as $$
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
    ), 0);
$$ language sql stable;

create function purchase_return_lines_no_over_return() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
begin
  select bill_id into v_bill_id from ap_credit_notes where id = new.credit_note_id;
  select id into v_grn_id from goods_receipt_notes where bill_id = v_bill_id;

  if v_grn_id is null then
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok per item', v_bill_id;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

  if not found then
    raise exception 'Item % gak ada di goods_receipt bill %, gak bisa diretur', new.item_id, v_bill_id;
  end if;

  select purchase_returned_qty(v_bill_id, new.item_id) into v_already;

  if v_already + new.qty_returned > v_qty_received then
    raise exception 'Retur item % melebihi qty diterima (diterima %, sudah diklaim %, coba retur %)',
      new.item_id, v_qty_received, v_already, new.qty_returned;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger purchase_return_lines_no_over_return_trigger
  before insert on purchase_return_lines
  for each row execute function purchase_return_lines_no_over_return();

create function purchase_replacement_lines_no_over_return() returns trigger as $$
declare
  v_bill_id uuid;
  v_grn_id uuid;
  v_qty_received numeric;
  v_already numeric;
begin
  select bill_id into v_bill_id from purchase_replacements where id = new.purchase_replacement_id;
  select id into v_grn_id from goods_receipt_notes where bill_id = v_bill_id;

  if v_grn_id is null then
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tukar barang per item', v_bill_id;
  end if;

  select qty_received into v_qty_received
    from goods_receipt_lines where grn_id = v_grn_id and item_id = new.item_id;

  if not found then
    raise exception 'Item % gak ada di goods_receipt bill %, gak bisa ditukar', new.item_id, v_bill_id;
  end if;

  select purchase_returned_qty(v_bill_id, new.item_id) into v_already;

  if v_already + new.qty_replaced > v_qty_received then
    raise exception 'Tukar barang item % melebihi qty diterima (diterima %, sudah diklaim %, coba tukar %)',
      new.item_id, v_qty_received, v_already, new.qty_replaced;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger purchase_replacement_lines_no_over_return_trigger
  before insert on purchase_replacement_lines
  for each row execute function purchase_replacement_lines_no_over_return();

-- ============================================================
-- ap_return_credits + ap_return_credit_applications + ap_return_credit_refunds (mirror
-- ar_return_credits, arah asset kebalik — di AR liability ke customer, di sini asset ke
-- supplier. Beda dari AR: titip/apply ke bill lain TETAP ADA di AP, sengaja gak dicabut.)
-- ============================================================

create table ap_return_credits (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  credit_note_id uuid not null references ap_credit_notes(id),
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_return_credits_supplier_id_idx on ap_return_credits(supplier_id);
create index ap_return_credits_credit_note_id_idx on ap_return_credits(credit_note_id);

create trigger ap_return_credits_block_edit_delete
  before update or delete on ap_return_credits
  for each row execute function block_edit_delete();

create table ap_return_credit_applications (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ap_return_credits(id),
  bill_id uuid not null references ap_bills(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_return_credit_applications_credit_id_idx on ap_return_credit_applications(credit_id);
create index ap_return_credit_applications_bill_id_idx on ap_return_credit_applications(bill_id);

create trigger ap_return_credit_applications_block_edit_delete
  before update or delete on ap_return_credit_applications
  for each row execute function block_edit_delete();

create table ap_return_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ap_return_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_return_credit_refunds_credit_id_idx on ap_return_credit_refunds(credit_id);

create trigger ap_return_credit_refunds_block_edit_delete
  before update or delete on ap_return_credit_refunds
  for each row execute function block_edit_delete();

-- ============================================================
-- Fungsi "sumber kebenaran tunggal" — sisa outstanding riil per bill / per saldo kredit retur
-- ============================================================

create function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from ap_payment_allocations where bill_id = p_bill_id), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
    - coalesce((
        select sum(arca.amount) from ap_return_credit_applications arca
        where arca.bill_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = arca.journal_entry_id
          )
      ), 0)
  from ap_bills ab
  where ab.id = p_bill_id;
$$ language sql stable;

create function ap_return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((
        select sum(arca.amount) from ap_return_credit_applications arca
        where arca.credit_id = p_credit_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = arca.journal_entry_id
          )
      ), 0)
    - coalesce((select sum(amount) from ap_return_credit_refunds where credit_id = p_credit_id), 0)
  from ap_return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

create function ap_payment_allocations_no_over_allocation() returns trigger as $$
declare
  v_bill_remaining numeric;
  v_payment_amount numeric;
  v_payment_allocated numeric;
begin
  select ap_bill_remaining(new.bill_id) into v_bill_remaining;

  if new.amount > v_bill_remaining then
    raise exception 'Alokasi ke bill % melebihi sisa utang (sisa %, coba alokasi %)',
      new.bill_id, v_bill_remaining, new.amount;
  end if;

  select amount into v_payment_amount from ap_payments where id = new.payment_id;
  select coalesce(sum(amount), 0) into v_payment_allocated
    from ap_payment_allocations where payment_id = new.payment_id;

  if v_payment_allocated + new.amount > v_payment_amount then
    raise exception 'Alokasi dari payment % melebihi sisa yang belum teralokasi (sisa %, coba alokasi %)',
      new.payment_id, v_payment_amount - v_payment_allocated, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_payment_allocations_no_over_allocation_trigger
  before insert on ap_payment_allocations
  for each row execute function ap_payment_allocations_no_over_allocation();

create function ap_return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select ap_return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Refund saldo kredit retur % melebihi sisa saldo (sisa %, coba refund %)',
      new.credit_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_return_credit_refunds_guard_trigger
  before insert on ap_return_credit_refunds
  for each row execute function ap_return_credit_refunds_guard();

create function ap_return_credit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_credit_supplier_id uuid;
  v_bill_supplier_id uuid;
  v_bill_journal_entry_id uuid;
  v_bill_cancelled boolean;
  v_bill_remaining numeric;
begin
  select ap_return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Pemakaian saldo kredit retur % melebihi sisa saldo (sisa %, coba pakai %)',
      new.credit_id, v_remaining, new.amount;
  end if;

  select supplier_id into v_credit_supplier_id from ap_return_credits where id = new.credit_id;
  select supplier_id, journal_entry_id into v_bill_supplier_id, v_bill_journal_entry_id
    from ap_bills where id = new.bill_id;

  if v_credit_supplier_id is distinct from v_bill_supplier_id then
    raise exception 'Saldo kredit retur % milik supplier lain -- gak bisa dipakai motong bill %', new.credit_id, new.bill_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_bill_journal_entry_id
  ) into v_bill_cancelled;

  if v_bill_cancelled then
    raise exception 'Bill % udah dibatalkan -- gak bisa diterapkan saldo kredit retur ke situ', new.bill_id;
  end if;

  select ap_bill_remaining(new.bill_id) into v_bill_remaining;

  if new.amount > v_bill_remaining then
    raise exception 'Penerapan saldo kredit retur ke bill % melebihi sisa utang (sisa %, coba terapkan %)',
      new.bill_id, v_bill_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_return_credit_applications_guard_trigger
  before insert on ap_return_credit_applications
  for each row execute function ap_return_credit_applications_guard();

-- ============================================================
-- RPC
-- ============================================================

create function create_ap_bill(
  p_supplier_id uuid,
  p_bill_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_debit_account_id uuid,
  p_payable_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_bill_id uuid;
begin
  select payment_term_days into v_term_days from suppliers where id = p_supplier_id;
  v_due_date := p_bill_date + v_term_days;

  v_entry_id := create_journal_entry(
    p_bill_date, p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_debit_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_bills (supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_supplier_id, p_bill_date, v_due_date, p_description, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_bill_id;

  return v_bill_id;
end;
$$;

create function record_ap_payment(
  p_supplier_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_payable_account_id uuid,
  p_cash_account_id uuid,
  p_allocations jsonb -- array of {"bill_id": uuid, "amount": numeric}
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_payment_id uuid;
  v_alloc jsonb;
begin
  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan utang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_payments (supplier_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_supplier_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    insert into ap_payment_allocations (payment_id, bill_id, amount)
    values (v_payment_id, (v_alloc->>'bill_id')::uuid, (v_alloc->>'amount')::numeric);
  end loop;

  return v_payment_id;
end;
$$;

-- cancel_ap_bill: ditolak keras kalau bill udah punya alokasi payment ATAU udah pernah
-- diretur (ap_credit_notes) — 2 hal itu keputusan bisnis, bukan reklasifikasi. Kalau bill ini
-- jadi TARGET ap_return_credit_applications (saldo kredit dari retur bill lain dipakai motong
-- bill ini), jurnalnya di-auto-reverse (reklasifikasi sederhana, aman dibalik).
create function cancel_ap_bill(
  p_bill_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_allocated_count int;
  v_credit_note_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
begin
  select count(*) into v_allocated_count
  from ap_payment_allocations where bill_id = p_bill_id;

  if v_allocated_count > 0 then
    raise exception 'Bill % udah punya % alokasi payment -- gak bisa dibatalkan lewat jalur ini', p_bill_id, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from ap_credit_notes where bill_id = p_bill_id;

  if v_credit_note_count > 0 then
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', p_bill_id, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from ap_bills where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select arca.journal_entry_id
    from ap_return_credit_applications arca
    where arca.bill_id = p_bill_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = arca.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

-- Opsi A — kurangi Utang Usaha. p_lines null/kosong -> financial-only (1 jurnal, p_amount
-- dipakai apa adanya). p_lines terisi -> jalur full, bill WAJIB punya goods_receipt_notes,
-- item WEIGHTED_AVERAGE. p_amount DIABAIKAN dan DIGANTI hasil penjumlahan cost fisik tiap
-- baris — Persediaan di GL harus sama persis sama nilai barang yang beneran keluar dari stok.
-- TANPA akun kontra (beda dari create_ar_credit_note) — Persediaan itu akun neraca.
create function create_ap_credit_note(
  p_bill_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_payable_account_id uuid,
  p_credit_account_id uuid,
  p_lines jsonb default null, -- array of {"item_id":uuid,"qty_returned":numeric}
  p_return_credit_asset_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining_before numeric;
  v_effective_amount numeric;
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_grn_id uuid;
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
begin
  select ap_bill_remaining(p_bill_id) into v_remaining_before;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

    if v_grn_id is null then
      raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa retur stok', p_bill_id;
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

  insert into ap_credit_notes (bill_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values (p_bill_id, p_credit_note_date, p_source_ref, v_effective_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  if array_length(v_line_items, 1) is not null then
    for i in 1..array_length(v_line_items, 1) loop
      insert into purchase_return_lines (credit_note_id, item_id, qty_returned, total_cost)
      values (v_credit_note_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
    end loop;
  end if;

  v_excess := greatest(0, v_effective_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_asset_account_id is null then
      raise exception 'Retur % bikin Utang Usaha jadi minus (excess %) -- wajib isi p_return_credit_asset_account_id',
        p_source_ref, v_excess;
    end if;

    select supplier_id into v_supplier_id from ap_bills where id = p_bill_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Piutang retur dari supplier', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_return_credit_asset_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into ap_return_credits (supplier_id, credit_note_id, amount, journal_entry_id, created_by)
    values (v_supplier_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  return v_credit_note_id;
end;
$$;

-- Opsi B — tukar barang, BERDIRI SENDIRI, gak lewat ap_credit_notes, Utang Usaha gak pernah
-- kesentuh. Jurnal: Debit Persediaan (barang baru) / Kredit Persediaan (barang rusak) —
-- akun yang SAMA di kedua baris, net nol, murni reklasifikasi fisik buat jejak audit.
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
begin
  select id into v_grn_id from goods_receipt_notes where bill_id = p_bill_id;

  if v_grn_id is null then
    raise exception 'Bill % gak punya goods_receipt_notes -- gak bisa tukar barang per item', p_bill_id;
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
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_replacement_id;
end;
$$;

create function apply_ap_return_credit(
  p_credit_id uuid,
  p_bill_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_return_credit_asset_account_id uuid,
  p_payable_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_application_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_entry_date, 'Penerapan saldo kredit retur ke bill', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_return_credit_asset_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_return_credit_applications (credit_id, bill_id, amount, source_ref, journal_entry_id, created_by)
  values (p_credit_id, p_bill_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_application_id;

  return v_application_id;
end;
$$;

create function refund_ap_return_credit(
  p_credit_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_return_credit_asset_account_id uuid,
  p_cash_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_refund_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_entry_date, 'Refund saldo kredit retur supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_return_credit_asset_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_return_credit_refunds (credit_id, amount, source_ref, journal_entry_id, created_by)
  values (p_credit_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

-- ============================================================
-- FK lintas-modul (deferred dari 0004_inventory_schema.sql — lihat catatan di sana)
-- ============================================================

alter table purchase_orders
  add constraint purchase_orders_supplier_id_fkey foreign key (supplier_id) references suppliers(id);

alter table goods_receipt_notes
  add constraint goods_receipt_notes_bill_id_fkey foreign key (bill_id) references ap_bills(id);

-- ============================================================
-- RLS Policy
-- ============================================================

alter table suppliers enable row level security;

create policy suppliers_select on suppliers
  for select using (auth.role() = 'authenticated');

create policy suppliers_insert on suppliers
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy suppliers_update on suppliers
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at, hard delete tertutup total

alter table ap_bills enable row level security;

create policy ap_bills_select on ap_bills
  for select using (auth.role() = 'authenticated');

create policy ap_bills_insert on ap_bills
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_payments enable row level security;

create policy ap_payments_select on ap_payments
  for select using (auth.role() = 'authenticated');

create policy ap_payments_insert on ap_payments
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_payment_allocations enable row level security;

create policy ap_payment_allocations_select on ap_payment_allocations
  for select using (auth.role() = 'authenticated');

create policy ap_payment_allocations_insert on ap_payment_allocations
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_credit_notes enable row level security;

create policy ap_credit_notes_select on ap_credit_notes
  for select using (auth.role() = 'authenticated');

create policy ap_credit_notes_insert on ap_credit_notes
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table purchase_return_lines enable row level security;

create policy purchase_return_lines_select on purchase_return_lines
  for select using (auth.role() = 'authenticated');

create policy purchase_return_lines_insert on purchase_return_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table purchase_replacements enable row level security;

create policy purchase_replacements_select on purchase_replacements
  for select using (auth.role() = 'authenticated');

create policy purchase_replacements_insert on purchase_replacements
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table purchase_replacement_lines enable row level security;

create policy purchase_replacement_lines_select on purchase_replacement_lines
  for select using (auth.role() = 'authenticated');

create policy purchase_replacement_lines_insert on purchase_replacement_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_return_credits enable row level security;

create policy ap_return_credits_select on ap_return_credits
  for select using (auth.role() = 'authenticated');

create policy ap_return_credits_insert on ap_return_credits
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_return_credit_applications enable row level security;

create policy ap_return_credit_applications_select on ap_return_credit_applications
  for select using (auth.role() = 'authenticated');

create policy ap_return_credit_applications_insert on ap_return_credit_applications
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_return_credit_refunds enable row level security;

create policy ap_return_credit_refunds_select on ap_return_credit_refunds
  for select using (auth.role() = 'authenticated');

create policy ap_return_credit_refunds_insert on ap_return_credit_refunds
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di semua tabel transaksional AP -> RLS default deny
-- + block_edit_delete

-- ============================================================
-- Grant
-- ============================================================

grant select, insert, update on suppliers to authenticated;
grant select, insert on ap_bills to authenticated;
grant select, insert on ap_payments to authenticated;
grant select, insert on ap_payment_allocations to authenticated;
grant select, insert on ap_credit_notes to authenticated;
grant select, insert on purchase_return_lines to authenticated;
grant select, insert on purchase_replacements to authenticated;
grant select, insert on purchase_replacement_lines to authenticated;
grant select, insert on ap_return_credits to authenticated;
grant select, insert on ap_return_credit_applications to authenticated;
grant select, insert on ap_return_credit_refunds to authenticated;
