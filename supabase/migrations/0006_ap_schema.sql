-- Accounts Payable schema.
-- Konsolidasi dari migration historis 0010/0035 (pra-squash) + 0009 (cabut apply_ap_return_
-- credit) + 0011 (Selaras AR — payment single bill) + 0013/0014 (Uang Muka/DP ke Supplier)
-- + 0016 (Kerugian Barang Rusak, Opsi C purchase writeoff) + bagian AP dari 0025
-- (Compounding & PPN) — lihat git log untuk riwayat evolusi.
-- Ref: docs/architecture/ap-schema.md
--
-- Beda desain dari AR (lihat 0005_ar_schema.sql): AP TIDAK mengikuti larangan titip-saldo-
-- kredit-retur yang diterapkan di AR — retur AP (ap_return_credits) cuma py 1 disposisi
-- (refund tunai), "dipakai motong bill lain" (ap_return_credit_applications) sudah dicabut
-- total (migration 0009) demi kesederhanaan, bukan konsistensi kebijakan penagihan (AP gak
-- pernah ikut kebijakan ketat yang berlaku di AR).

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

-- bill_id: FK langsung, gak unique (1 bill boleh punya banyak baris payment dari waktu ke
-- waktu -- cicil), mirror persis ar_payments.invoice_id (migration 0011 -- tabel jembatan
-- ap_payment_allocations many-to-many yang pernah ada sudah dicabut total, "bayar gabungan"
-- lintas bill gak lagi didukung, selaras filosofi AR).
create table ap_payments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  bill_id uuid not null references ap_bills(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_payments_supplier_id_idx on ap_payments(supplier_id);
create index ap_payments_bill_id_idx on ap_payments(bill_id);

create trigger ap_payments_block_edit_delete
  before update or delete on ap_payments
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

-- ============================================================
-- purchase_writeoffs + purchase_writeoff_lines (Opsi C — tulis-jadi-beban, migration 0016).
-- Supplier NOLAK kompensasi sama sekali (gak kurangin Utang Usaha, gak kirim pengganti) --
-- beda dari Opsi A (kurangi utang) dan Opsi B (tukar barang, net-nol). Berdiri sendiri sama
-- pola Opsi B, gak lewat ap_credit_notes. Jurnal: Debit Beban Kerugian Barang Rusak /
-- Kredit Persediaan Bahan Baku -- murni kerugian, beda dari Opsi B yang net-nol.
-- ============================================================

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

-- Total qty yang udah "diklaim" dari 1 item di 1 bill, GABUNGAN Opsi A (purchase_return_lines)
-- + Opsi B (purchase_replacement_lines) + Opsi C (purchase_writeoff_lines, migration 0016) —
-- fisiknya cuma ada 1 pool qty_received yang bisa diklaim, mau lewat jalur mana pun.
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
    ), 0)
    +
    coalesce((
      select sum(pwl.qty_written_off) from purchase_writeoff_lines pwl
      join purchase_writeoffs pw on pw.id = pwl.purchase_writeoff_id
      where pw.bill_id = p_bill_id and pwl.item_id = p_item_id
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

-- ============================================================
-- ap_return_credits + ap_return_credit_refunds (mirror ar_return_credits, arah asset
-- kebalik — di AR liability ke customer, di sini asset ke supplier). Cuma 1 disposisi
-- (refund tunai) — "dipakai motong bill lain" (ap_return_credit_applications) sudah
-- dicabut total (migration 0009), murni soal kesederhanaan.
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
-- ap_deposits (Uang Muka ke Supplier, migration 0013) + ap_deposit_applications +
-- ap_deposit_refunds + ap_deposit_forfeitures -- mirror AR Deposit, arah kebalik (asset
-- "Uang Muka Pembelian" bukan liability, karena supplier yang "berutang" balik ke kita).
-- Beda dari AR: dibangun partial-capable DAN dengan 2 disposisi (refund + hangus) dari
-- AWAL -- bukan retrofit belakangan -- karena kebijakan refund-tidaknya DP ke supplier itu
-- SUPPLIER yang nentuin (bukan kita).
-- ============================================================

create table ap_deposits (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id),
  deposit_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_deposits_supplier_id_idx on ap_deposits(supplier_id);
create index ap_deposits_journal_entry_id_idx on ap_deposits(journal_entry_id);

create trigger ap_deposits_block_edit_delete
  before update or delete on ap_deposits
  for each row execute function block_edit_delete();

create table ap_deposit_applications (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ap_deposits(id),
  bill_id uuid not null references ap_bills(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_deposit_applications_deposit_id_idx on ap_deposit_applications(deposit_id);
create index ap_deposit_applications_bill_id_idx on ap_deposit_applications(bill_id);

create trigger ap_deposit_applications_block_edit_delete
  before update or delete on ap_deposit_applications
  for each row execute function block_edit_delete();

create table ap_deposit_refunds (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ap_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  refund_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_deposit_refunds_deposit_id_idx on ap_deposit_refunds(deposit_id);

create trigger ap_deposit_refunds_block_edit_delete
  before update or delete on ap_deposit_refunds
  for each row execute function block_edit_delete();

create table ap_deposit_forfeitures (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ap_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  forfeiture_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ap_deposit_forfeitures_deposit_id_idx on ap_deposit_forfeitures(deposit_id);

create trigger ap_deposit_forfeitures_block_edit_delete
  before update or delete on ap_deposit_forfeitures
  for each row execute function block_edit_delete();

-- ap_deposit_remaining -- sumber kebenaran tunggal, mirror ar_deposit_remaining(). Applications
-- exclude-reversed (bisa di-unwind cancel_ap_bill); refunds & forfeitures gak pernah punya
-- jalur reversal, SUM langsung.
create function ap_deposit_remaining(p_deposit_id uuid) returns numeric as $$
  select ad.amount
    - coalesce((
        select sum(ada.amount) from ap_deposit_applications ada
        where ada.deposit_id = p_deposit_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    - coalesce((select sum(amount) from ap_deposit_refunds where deposit_id = p_deposit_id), 0)
    - coalesce((select sum(amount) from ap_deposit_forfeitures where deposit_id = p_deposit_id), 0)
  from ap_deposits ad
  where ad.id = p_deposit_id;
$$ language sql stable;

-- Guard trigger tiap tabel transaksional -- semuanya cek ap_deposit_remaining(), gak ada
-- aturan "1 disposisi aktif" (ketiganya boleh campur dari awal, beda dari AR pra-0012).
create function ap_deposit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_supplier_id uuid;
  v_bill_supplier_id uuid;
  v_bill_journal_entry_id uuid;
  v_bill_cancelled boolean;
  v_bill_remaining numeric;
begin
  select ap_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Penerapan deposit % melebihi sisa deposit (sisa %, coba terapkan %)',
      new.deposit_id, v_remaining, new.amount;
  end if;

  select supplier_id into v_deposit_supplier_id from ap_deposits where id = new.deposit_id;
  select supplier_id, journal_entry_id into v_bill_supplier_id, v_bill_journal_entry_id
    from ap_bills where id = new.bill_id;

  if v_bill_supplier_id is distinct from v_deposit_supplier_id then
    raise exception 'Deposit % milik supplier lain -- gak bisa diterapkan ke bill %', new.deposit_id, new.bill_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_bill_journal_entry_id
  ) into v_bill_cancelled;

  if v_bill_cancelled then
    raise exception 'Bill % udah dibatalkan -- gak bisa diterapkan DP ke situ', new.bill_id;
  end if;

  select ap_bill_remaining(new.bill_id) into v_bill_remaining;

  if new.amount > v_bill_remaining then
    raise exception 'Penerapan deposit ke bill % melebihi sisa utang (sisa %, coba terapkan %)',
      new.bill_id, v_bill_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_deposit_applications_guard_trigger
  before insert on ap_deposit_applications
  for each row execute function ap_deposit_applications_guard();

create function ap_deposit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select ap_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Refund deposit % melebihi sisa deposit (sisa %, coba refund %)',
      new.deposit_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_deposit_refunds_guard_trigger
  before insert on ap_deposit_refunds
  for each row execute function ap_deposit_refunds_guard();

create function ap_deposit_forfeitures_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select ap_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Forfeiture deposit % melebihi sisa deposit (sisa %, coba hanguskan %)',
      new.deposit_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ap_deposit_forfeitures_guard_trigger
  before insert on ap_deposit_forfeitures
  for each row execute function ap_deposit_forfeitures_guard();

-- ============================================================
-- Fungsi "sumber kebenaran tunggal" — sisa outstanding riil per bill / per saldo kredit
-- retur (terakhir didefinisi 0013 — ap_bill_remaining nambah reducer ke-3 ap_deposit_
-- applications; ap_return_credit_remaining terakhir didefinisi 0009 — reducer "applications"
-- yang dicabut migration itu udah gak ada lagi, cuma sisa refund).
-- ============================================================

create function ap_bill_remaining(p_bill_id uuid) returns numeric as $$
  select ab.amount
    - coalesce((select sum(amount) from ap_payments where bill_id = p_bill_id), 0)
    - coalesce((select sum(amount) from ap_credit_notes where bill_id = p_bill_id), 0)
    - coalesce((
        select sum(ada.amount) from ap_deposit_applications ada
        where ada.bill_id = p_bill_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
  from ap_bills ab
  where ab.id = p_bill_id;
$$ language sql stable;

create function ap_return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((select sum(amount) from ap_return_credit_refunds where credit_id = p_credit_id), 0)
  from ap_return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

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

-- ============================================================
-- Kategori Campur & PPN (Compounding, bagian AP dari migration 0025) —
-- memory/scope-debt/compound-transactional-entries.md (sudah dihapus, ditutup di sini).
-- ap_bill_debit_lines: baris debit aktual per bill, kalau lebih dari 1 kategori.
-- ap_bill_expense_categories: katalog master data (dropdown kategori di form AP Bill) —
-- gak ada FK ke ap_bill_debit_lines, murni resolve pilihan di UI. tax_settings (PPN
-- Masukan) didefinisikan di 0005_ar_schema.sql, dipakai bareng di sini.
-- ============================================================

create table ap_bill_debit_lines (
  id uuid primary key default gen_random_uuid(),
  ap_bill_id uuid not null references ap_bills(id) on delete cascade,
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false,
  created_at timestamptz not null default now()
);

create index ap_bill_debit_lines_ap_bill_id_idx on ap_bill_debit_lines(ap_bill_id);

create trigger ap_bill_debit_lines_block_edit_delete
  before update or delete on ap_bill_debit_lines
  for each row execute function block_edit_delete();

create table ap_bill_expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger ap_bill_expense_categories_set_updated_at
  before update on ap_bill_expense_categories
  for each row execute function set_updated_at();

-- ============================================================
-- RPC
-- ============================================================

-- create_ap_bill (terakhir didefinisi 0025) — sisi debit sekarang array (p_debit_lines),
-- bisa dipecah kategori (mis. Persediaan + Beban Ongkir dalam 1 nota). Sisi kredit (Utang
-- Usaha) TETAP 1 baris. PPN Masukan (p_apply_tax) dihitung server-side dari tax_settings,
-- ditambahkan ke Utang Usaha, gak pernah dari input klien.
create function create_ap_bill(
  p_supplier_id uuid,
  p_bill_date date,
  p_description text,
  p_source_ref text,
  p_debit_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- Persediaan/Beban, BUKAN termasuk PPN
  p_payable_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_bill_id uuid;
  v_line jsonb;
  v_line_amount numeric;
  v_subtotal numeric := 0;
  v_tax_amount numeric := 0;
  v_total_amount numeric;
  v_tax_active boolean;
  v_tax_rate numeric;
  v_tax_account_id uuid;
  v_journal_lines jsonb := '[]'::jsonb;
begin
  if p_debit_lines is null or jsonb_array_length(p_debit_lines) = 0 then
    raise exception 'AP bill wajib punya minimal 1 baris debit';
  end if;

  select payment_term_days into v_term_days from suppliers where id = p_supplier_id;
  v_due_date := p_bill_date + v_term_days;

  for v_line in select * from jsonb_array_elements(p_debit_lines)
  loop
    v_line_amount := (v_line->>'amount')::numeric;
    if v_line_amount <= 0 then
      raise exception 'Nominal baris debit harus > 0';
    end if;
    v_subtotal := v_subtotal + v_line_amount;
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', v_line_amount, 'credit', 0)
    );
  end loop;

  if p_apply_tax then
    select is_active, ppn_rate, ppn_masukan_account_id
      into v_tax_active, v_tax_rate, v_tax_account_id
      from tax_settings where id = true;

    if not coalesce(v_tax_active, false) then
      raise exception 'PPN gak aktif di Pengaturan Pajak -- gak bisa nambah baris PPN Masukan';
    end if;
    if v_tax_account_id is null then
      raise exception 'Akun PPN Masukan belum diset di Pengaturan Pajak';
    end if;

    v_tax_amount := round(v_subtotal * v_tax_rate / 100, 2);
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax_account_id, 'debit', v_tax_amount, 'credit', 0)
    );
  end if;

  v_total_amount := v_subtotal + v_tax_amount;

  v_journal_lines := v_journal_lines || jsonb_build_array(
    jsonb_build_object('account_id', p_payable_account_id, 'debit', 0, 'credit', v_total_amount)
  );

  v_entry_id := create_journal_entry(p_bill_date, p_description, p_source_ref, v_journal_lines);

  insert into ap_bills (supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_supplier_id, p_bill_date, v_due_date, p_description, p_source_ref, v_total_amount, v_entry_id, auth.uid())
  returning id into v_bill_id;

  for v_line in select * from jsonb_array_elements(p_debit_lines)
  loop
    insert into ap_bill_debit_lines (ap_bill_id, account_id, amount, is_tax)
    values (v_bill_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
  end loop;

  if p_apply_tax then
    insert into ap_bill_debit_lines (ap_bill_id, account_id, amount, is_tax)
    values (v_bill_id, v_tax_account_id, v_tax_amount, true);
  end if;

  return v_bill_id;
end;
$$;

-- record_ap_payment (terakhir didefinisi 0011) — p_bill_id tunggal (bukan p_allocations
-- jsonb array yang pernah ada) — boleh CICIL, tapi 1 payment WAJIB nunjuk 1 bill spesifik.
-- Guard sama persis pola record_ar_payment -- cuma tolak kalau MELEBIHI sisa (overpay).
create function record_ap_payment(
  p_supplier_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_payable_account_id uuid,
  p_cash_account_id uuid,
  p_bill_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
begin
  select ap_bill_remaining(p_bill_id) into v_remaining;

  if p_amount > v_remaining then
    raise exception 'Payment % melebihi sisa utang bill % (sisa %, coba bayar %) -- gak boleh overpay',
      p_source_ref, p_bill_id, v_remaining, p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan utang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_payments (supplier_id, bill_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_supplier_id, p_bill_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

-- cancel_ap_bill (terakhir didefinisi 0013) — ditolak keras kalau bill udah punya payment
-- ATAU udah pernah diretur (ap_credit_notes). Kalau bill ini jadi target ap_deposit_
-- applications aktif, jurnalnya di-auto-reverse (reklasifikasi sederhana, aman dibalik).
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
  from ap_payments where bill_id = p_bill_id;

  if v_allocated_count > 0 then
    raise exception 'Bill % udah punya % payment -- gak bisa dibatalkan lewat jalur ini', p_bill_id, v_allocated_count;
  end if;

  select count(*) into v_credit_note_count
  from ap_credit_notes where bill_id = p_bill_id;

  if v_credit_note_count > 0 then
    raise exception 'Bill % udah punya % retur (credit note) -- gak bisa dibatalkan lewat jalur ini', p_bill_id, v_credit_note_count;
  end if;

  select journal_entry_id into v_original_entry_id from ap_bills where id = p_bill_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select ada.journal_entry_id
    from ap_deposit_applications ada
    where ada.bill_id = p_bill_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
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

-- create_purchase_writeoff (Opsi C, migration 0016) -- mirror create_purchase_replacement,
-- bedanya jurnal BUKAN net-nol (Debit Beban Kerugian Barang Rusak / Kredit Persediaan Bahan
-- Baku, 2 akun beda), karena gak ada barang pengganti yang masuk.
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

create function create_ap_deposit(
  p_supplier_id uuid,
  p_deposit_date date,
  p_source_ref text,
  p_amount numeric,
  p_deposit_asset_account_id uuid,
  p_cash_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_deposit_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_deposit_date, 'Uang muka dibayar ke supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_deposit_asset_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_deposits (supplier_id, deposit_date, source_ref, amount, journal_entry_id, created_by)
  values (p_supplier_id, p_deposit_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_deposit_id;

  return v_deposit_id;
end;
$$;

create function apply_ap_deposit(
  p_deposit_id uuid,
  p_bill_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_payable_account_id uuid,
  p_deposit_asset_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_application_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_entry_date, 'Penerapan uang muka ke bill', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_payable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_deposit_asset_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_deposit_applications (deposit_id, bill_id, amount, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_bill_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_application_id;

  return v_application_id;
end;
$$;

create function refund_ap_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_refund_date date,
  p_source_ref text,
  p_cash_account_id uuid,
  p_deposit_asset_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_refund_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_refund_date, 'Refund uang muka dari supplier', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_deposit_asset_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_deposit_refunds (deposit_id, amount, refund_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_refund_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

create function forfeit_ap_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_forfeiture_date date,
  p_source_ref text,
  p_loss_expense_account_id uuid,
  p_deposit_asset_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_forfeiture_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_forfeiture_date, 'Uang muka hangus', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_loss_expense_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_deposit_asset_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ap_deposit_forfeitures (deposit_id, amount, forfeiture_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_forfeiture_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_forfeiture_id;

  return v_forfeiture_id;
end;
$$;

-- ============================================================
-- Seed — akun baru buat AP Deposit (migration 0014), pola sama semua akun baru lain.
-- ============================================================

insert into accounts (code, name, category) values
  ('1360', 'Uang Muka Pembelian', 'asset'),
  ('5800', 'Beban Kerugian Uang Muka', 'expense');

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

alter table ap_return_credits enable row level security;

create policy ap_return_credits_select on ap_return_credits
  for select using (auth.role() = 'authenticated');

create policy ap_return_credits_insert on ap_return_credits
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

alter table ap_deposits enable row level security;

create policy ap_deposits_select on ap_deposits
  for select using (auth.role() = 'authenticated');

create policy ap_deposits_insert on ap_deposits
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_deposit_applications enable row level security;

create policy ap_deposit_applications_select on ap_deposit_applications
  for select using (auth.role() = 'authenticated');

create policy ap_deposit_applications_insert on ap_deposit_applications
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_deposit_refunds enable row level security;

create policy ap_deposit_refunds_select on ap_deposit_refunds
  for select using (auth.role() = 'authenticated');

create policy ap_deposit_refunds_insert on ap_deposit_refunds
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ap_deposit_forfeitures enable row level security;

create policy ap_deposit_forfeitures_select on ap_deposit_forfeitures
  for select using (auth.role() = 'authenticated');

create policy ap_deposit_forfeitures_insert on ap_deposit_forfeitures
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di semua tabel transaksional AP di atas -> RLS
-- default deny + block_edit_delete

alter table ap_bill_debit_lines enable row level security;

create policy ap_bill_debit_lines_select on ap_bill_debit_lines
  for select using (auth.role() = 'authenticated');

create policy ap_bill_debit_lines_insert on ap_bill_debit_lines
  for insert with check (
    exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

-- ap_bill_expense_categories: katalog master data, select semua authenticated, insert+update
-- admin doang (owner yang setup katalog). Gak ada delete -- nonaktifkan pakai archived_at.
alter table ap_bill_expense_categories enable row level security;

create policy ap_bill_expense_categories_select on ap_bill_expense_categories for select using (auth.role() = 'authenticated');
create policy ap_bill_expense_categories_insert on ap_bill_expense_categories for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy ap_bill_expense_categories_update on ap_bill_expense_categories for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

-- ============================================================
-- Grant
-- ============================================================

grant select, insert, update on suppliers to authenticated;
grant select, insert on ap_bills to authenticated;
grant select, insert on ap_payments to authenticated;
grant select, insert on ap_credit_notes to authenticated;
grant select, insert on purchase_return_lines to authenticated;
grant select, insert on purchase_replacements to authenticated;
grant select, insert on purchase_replacement_lines to authenticated;
grant select, insert on purchase_writeoffs to authenticated;
grant select, insert on purchase_writeoff_lines to authenticated;
grant select, insert on ap_return_credits to authenticated;
grant select, insert on ap_return_credit_refunds to authenticated;
grant select, insert on ap_deposits to authenticated;
grant select, insert on ap_deposit_applications to authenticated;
grant select, insert on ap_deposit_refunds to authenticated;
grant select, insert on ap_deposit_forfeitures to authenticated;
grant select, insert on ap_bill_debit_lines to authenticated;
grant select, insert, update on ap_bill_expense_categories to authenticated;
