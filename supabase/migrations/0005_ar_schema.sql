-- Accounts Receivable schema.
-- Konsolidasi dari migration historis 0007/0009/0020/0021/0024/0026/0029/0031/0037/0039/
-- 0040/0041 (pra-squash) + 0010 (Cicil Dibalikin) + 0012 (Deposit Refund & Partial) + 0015
-- (Kerugian Barang Rusak, DAMAGED condition) + bagian AR dari 0025 (Compounding & PPN) —
-- lihat git log untuk riwayat evolusi (termasuk fitur yang pernah ada lalu dihapus lagi:
-- batas waktu retur, alokasi payment many-to-many, overpayment-to-credit, titip saldo
-- kredit retur ke invoice lain).
-- Ref: docs/architecture/ar-schema.md
--
-- inventory_returns/inventory_return_lines dan warranty_replacement_lines ditaruh di sini
-- (bukan modul inventory) karena FK ke ar_credit_notes/tabel modul ini. FK
-- goods_issues.invoice_id dan sales_orders.customer_id (dideklarasikan polos tanpa
-- references di 0004_inventory_schema.sql) ditambahkan di akhir file ini, setelah
-- ar_invoices/customers dibuat.

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null default 7 check (payment_term_days > 0),
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit > 0),
  overdue_threshold_days int check (overdue_threshold_days is null or overdue_threshold_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger customers_set_updated_at
  before update on customers
  for each row execute function set_updated_at();

create table ar_invoices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  invoice_date date not null,
  due_date date not null,
  description text,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_invoices_customer_id_idx on ar_invoices(customer_id);
create index ar_invoices_journal_entry_id_idx on ar_invoices(journal_entry_id);

create trigger ar_invoices_block_edit_delete
  before update or delete on ar_invoices
  for each row execute function block_edit_delete();

-- ar_payments.invoice_id: WAJIB nunjuk 1 invoice spesifik (gak ada gabung invoice, gak ada
-- alokasi many-to-many), tapi TIDAK unique (migration 0010) — 1 invoice boleh punya banyak
-- baris payment dari waktu ke waktu (cicil). Index eksplisit gantiin unique constraint yang
-- pernah ada, biar lookup invoice_id tetap gak jadi seq scan (ar_invoice_remaining() manggil
-- ini di banyak jalur hot-path).
create table ar_payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  invoice_id uuid not null references ar_invoices(id),
  payment_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_payments_customer_id_idx on ar_payments(customer_id);
create index ar_payments_invoice_id_idx on ar_payments(invoice_id);

create trigger ar_payments_block_edit_delete
  before update or delete on ar_payments
  for each row execute function block_edit_delete();

-- ============================================================
-- ar_credit_notes (retur barang, AR-side) + inventory_returns/inventory_return_lines
-- (Inventory-side, cuma jalur full — retur yang lewat create_goods_issue)
-- ============================================================

create table ar_credit_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references ar_invoices(id),
  credit_note_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_credit_notes_invoice_id_idx on ar_credit_notes(invoice_id);
create index ar_credit_notes_journal_entry_id_idx on ar_credit_notes(journal_entry_id);

create trigger ar_credit_notes_block_edit_delete
  before update or delete on ar_credit_notes
  for each row execute function block_edit_delete();

create function ar_credit_notes_no_over_return() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_already_returned numeric;
begin
  select amount into v_invoice_amount from ar_invoices where id = new.invoice_id;
  select coalesce(sum(amount), 0) into v_already_returned
    from ar_credit_notes where invoice_id = new.invoice_id;

  if v_already_returned + new.amount > v_invoice_amount then
    raise exception 'Retur invoice % melebihi nilai invoice (invoice %, sudah diretur %, coba retur %)',
      new.invoice_id, v_invoice_amount, v_already_returned, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_credit_notes_no_over_return_trigger
  before insert on ar_credit_notes
  for each row execute function ar_credit_notes_no_over_return();

create table inventory_returns (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ar_credit_notes(id),
  goods_issue_id uuid not null references goods_issues(id),
  journal_entry_id uuid not null references journal_entries(id),
  return_date date not null,
  source_ref text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index inventory_returns_credit_note_id_idx on inventory_returns(credit_note_id);
create index inventory_returns_goods_issue_id_idx on inventory_returns(goods_issue_id);

create trigger inventory_returns_block_edit_delete
  before update or delete on inventory_returns
  for each row execute function block_edit_delete();

-- condition (migration 0015, Kerugian Barang Rusak): RESALABLE (default, perilaku awal —
-- balik masuk stok) atau DAMAGED (gak balik masuk stok, cost-nya direklasifikasi jadi Beban
-- Kerugian Barang Rusak, akun 5900 — lihat seed di bawah).
create table inventory_return_lines (
  id uuid primary key default gen_random_uuid(),
  inventory_return_id uuid not null references inventory_returns(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_returned numeric(14,3) not null check (qty_returned > 0),
  total_cost numeric(14,2) not null check (total_cost > 0),
  condition text not null default 'RESALABLE' check (condition in ('RESALABLE', 'DAMAGED'))
);

create index inventory_return_lines_return_id_idx on inventory_return_lines(inventory_return_id);

create trigger inventory_return_lines_block_edit_delete
  before update or delete on inventory_return_lines
  for each row execute function block_edit_delete();

-- Guard: no-over-return (qty gak boleh ngelebihin qty_issued). Batas waktu retur per item
-- pernah ada di sini (0021 pra-squash), dicabut total (keputusan bisnis — retur
-- diterima/ditolak sekarang murni keputusan manual owner/staff, bukan hard-reject sistem).
create function inventory_return_lines_guard() returns trigger as $$
declare
  v_goods_issue_id uuid;
  v_qty_issued numeric;
  v_qty_already_returned numeric;
begin
  select ir.goods_issue_id into v_goods_issue_id
    from inventory_returns ir where ir.id = new.inventory_return_id;

  select gil.qty_issued into v_qty_issued
    from goods_issue_lines gil
    where gil.goods_issue_id = v_goods_issue_id and gil.item_id = new.item_id;

  if not found then
    raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', new.item_id, v_goods_issue_id;
  end if;

  select coalesce(sum(irl.qty_returned), 0) into v_qty_already_returned
    from inventory_return_lines irl
    join inventory_returns ir2 on ir2.id = irl.inventory_return_id
    where ir2.goods_issue_id = v_goods_issue_id and irl.item_id = new.item_id;

  if v_qty_already_returned + new.qty_returned > v_qty_issued then
    raise exception 'Retur item % melebihi qty terjual (terjual %, sudah diretur %, coba retur %)',
      new.item_id, v_qty_issued, v_qty_already_returned, new.qty_returned;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger inventory_return_lines_guard_trigger
  before insert on inventory_return_lines
  for each row execute function inventory_return_lines_guard();

-- ============================================================
-- ar_deposits (Uang Muka/DP) + ar_deposit_applications + ar_deposit_forfeitures +
-- ar_deposit_refunds (migration 0012 — ketiganya partial-capable, bisa campur bebas)
-- ============================================================

create table ar_deposits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  deposit_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_deposits_customer_id_idx on ar_deposits(customer_id);
create index ar_deposits_journal_entry_id_idx on ar_deposits(journal_entry_id);

create trigger ar_deposits_block_edit_delete
  before update or delete on ar_deposits
  for each row execute function block_edit_delete();

create table ar_deposit_applications (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ar_deposits(id),
  invoice_id uuid not null references ar_invoices(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_deposit_applications_deposit_id_idx on ar_deposit_applications(deposit_id);
create index ar_deposit_applications_invoice_id_idx on ar_deposit_applications(invoice_id);

create trigger ar_deposit_applications_block_edit_delete
  before update or delete on ar_deposit_applications
  for each row execute function block_edit_delete();

-- amount (migration 0012) — sebelumnya selalu diambil dari ar_deposits.amount penuh
-- (gak disimpan per baris karena selalu 1x jalan sekali putus). Sekarang partial-capable.
create table ar_deposit_forfeitures (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ar_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  forfeiture_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_deposit_forfeitures_deposit_id_idx on ar_deposit_forfeitures(deposit_id);

create trigger ar_deposit_forfeitures_block_edit_delete
  before update or delete on ar_deposit_forfeitures
  for each row execute function block_edit_delete();

-- Disposisi baru (migration 0012) — mirror ar_deposit_forfeitures tapi lawan jurnalnya Kas
-- (bukan Pendapatan Lain-lain) — refund gak punya dampak Laba Rugi.
create table ar_deposit_refunds (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ar_deposits(id),
  amount numeric(14,2) not null check (amount > 0),
  refund_date date not null,
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_deposit_refunds_deposit_id_idx on ar_deposit_refunds(deposit_id);

create trigger ar_deposit_refunds_block_edit_delete
  before update or delete on ar_deposit_refunds
  for each row execute function block_edit_delete();

-- ============================================================
-- ar_bad_debt_writeoffs (Piutang Tak Tertagih, direct write-off method)
-- ============================================================

create table ar_bad_debt_writeoffs (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references ar_invoices(id),
  writeoff_date date not null,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_bad_debt_writeoffs_invoice_id_idx on ar_bad_debt_writeoffs(invoice_id);
create index ar_bad_debt_writeoffs_journal_entry_id_idx on ar_bad_debt_writeoffs(journal_entry_id);

create trigger ar_bad_debt_writeoffs_block_edit_delete
  before update or delete on ar_bad_debt_writeoffs
  for each row execute function block_edit_delete();

-- ============================================================
-- ar_return_credits (saldo kredit lahir dari retur yang bikin outstanding invoice minus)
-- + ar_return_credit_refunds (refund tunai). Titip/apply ke invoice lain (yang tadinya ada
-- di sini) dicabut total — cuma boleh diselesaikan refund kas ATAU ganti barang
-- (warranty_replacements.return_credit_settled_amount, di bawah).
-- ============================================================

create table ar_return_credits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  credit_note_id uuid not null references ar_credit_notes(id),
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_return_credits_customer_id_idx on ar_return_credits(customer_id);
create index ar_return_credits_credit_note_id_idx on ar_return_credits(credit_note_id);

create trigger ar_return_credits_block_edit_delete
  before update or delete on ar_return_credits
  for each row execute function block_edit_delete();

create table ar_return_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ar_return_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_return_credit_refunds_credit_id_idx on ar_return_credit_refunds(credit_id);

create trigger ar_return_credit_refunds_block_edit_delete
  before update or delete on ar_return_credit_refunds
  for each row execute function block_edit_delete();

-- ============================================================
-- warranty_replacements (Penggantian Barang Gratis Pasca-Retur) + warranty_replacement_lines
-- ============================================================

create table warranty_replacements (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references ar_credit_notes(id),
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

create index warranty_replacements_credit_note_id_idx on warranty_replacements(credit_note_id);
create index warranty_replacements_journal_entry_id_idx on warranty_replacements(journal_entry_id);

create trigger warranty_replacements_block_edit_delete
  before update or delete on warranty_replacements
  for each row execute function block_edit_delete();

create table warranty_replacement_lines (
  id uuid primary key default gen_random_uuid(),
  warranty_replacement_id uuid not null references warranty_replacements(id) on delete cascade,
  item_id uuid not null references items(id),
  qty_replaced numeric(14,3) not null check (qty_replaced > 0),
  total_cost numeric(14,2) not null check (total_cost > 0)
);

create index warranty_replacement_lines_replacement_id_idx on warranty_replacement_lines(warranty_replacement_id);

create trigger warranty_replacement_lines_block_edit_delete
  before update or delete on warranty_replacement_lines
  for each row execute function block_edit_delete();

-- Guard no-over-replace: qty diganti (akumulasi, per item, per credit note) gak boleh
-- ngelebihin qty yang beneran diretur di credit note itu.
create function warranty_replacement_lines_no_over_replace() returns trigger as $$
declare
  v_credit_note_id uuid;
  v_qty_returned numeric;
  v_qty_already_replaced numeric;
begin
  select wr.credit_note_id into v_credit_note_id
    from warranty_replacements wr where wr.id = new.warranty_replacement_id;

  select coalesce(sum(irl.qty_returned), 0) into v_qty_returned
    from inventory_return_lines irl
    join inventory_returns ir on ir.id = irl.inventory_return_id
    where ir.credit_note_id = v_credit_note_id and irl.item_id = new.item_id;

  if v_qty_returned = 0 then
    raise exception 'Item % gak ada di retur credit note %, gak bisa diganti', new.item_id, v_credit_note_id;
  end if;

  select coalesce(sum(wrl.qty_replaced), 0) into v_qty_already_replaced
    from warranty_replacement_lines wrl
    join warranty_replacements wr2 on wr2.id = wrl.warranty_replacement_id
    where wr2.credit_note_id = v_credit_note_id and wrl.item_id = new.item_id;

  if v_qty_already_replaced + new.qty_replaced > v_qty_returned then
    raise exception 'Penggantian item % melebihi qty retur (diretur %, sudah diganti %, coba ganti %)',
      new.item_id, v_qty_returned, v_qty_already_replaced, new.qty_replaced;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger warranty_replacement_lines_no_over_replace_trigger
  before insert on warranty_replacement_lines
  for each row execute function warranty_replacement_lines_no_over_replace();

-- Guard: total diskon yang dibalik (akumulasi lintas semua warranty_replacement) gak boleh
-- ngelebihin diskon yang sebenarnya diberikan credit note itu.
create function warranty_replacements_no_over_reverse() returns trigger as $$
declare
  v_credit_note_amount numeric;
  v_already_reversed numeric;
begin
  select amount into v_credit_note_amount from ar_credit_notes where id = new.credit_note_id;

  select coalesce(sum(discount_reversed_amount), 0) into v_already_reversed
    from warranty_replacements where credit_note_id = new.credit_note_id;

  if v_already_reversed + new.discount_reversed_amount > v_credit_note_amount then
    raise exception 'Pembalikan diskon retur melebihi diskon yang diberikan (diskon %, sudah dibalik %, coba balik %)',
      v_credit_note_amount, v_already_reversed, new.discount_reversed_amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger warranty_replacements_no_over_reverse_trigger
  before insert on warranty_replacements
  for each row execute function warranty_replacements_no_over_reverse();

-- Guard: total settlement saldo kredit retur (akumulasi lintas semua warranty_replacement
-- buat 1 credit note) gak boleh ngelebihin sisa saldo ar_return_credits yang match.
create function warranty_replacements_no_over_settle_return_credit() returns trigger as $$
declare
  v_credit_id uuid;
  v_remaining numeric;
begin
  if new.return_credit_settled_amount = 0 then
    return new;
  end if;

  select id into v_credit_id from ar_return_credits where credit_note_id = new.credit_note_id;

  if v_credit_id is null then
    raise exception 'Credit note % gak punya saldo kredit retur aktif — gak bisa isi return_credit_settled_amount', new.credit_note_id;
  end if;

  select ar_return_credit_remaining(v_credit_id) into v_remaining;

  if new.return_credit_settled_amount > v_remaining then
    raise exception 'Penyelesaian saldo kredit retur % melebihi sisa saldo (sisa %, coba selesaikan %)',
      v_credit_id, v_remaining, new.return_credit_settled_amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger warranty_replacements_no_over_settle_return_credit_trigger
  before insert on warranty_replacements
  for each row execute function warranty_replacements_no_over_settle_return_credit();

-- ============================================================
-- Fungsi "sumber kebenaran tunggal" — sisa outstanding riil per invoice / per saldo
-- kredit retur / per DP. Dipanggil semua guard/RPC AR, jangan hitung ulang manual di
-- tempat lain.
-- ============================================================

-- 4 reducer: ar_payments (SUM, migration 0010 -- boleh cicil/banyak baris per invoice,
-- sebelumnya cuma 1 baris exact-match), ar_credit_notes, ar_deposit_applications aktif,
-- ar_bad_debt_writeoffs aktif. Reducer alokasi many-to-many/overpayment-to-credit/titip-
-- return-credit yang pernah ada di sini (pra-squash) sudah dicabut total bareng fiturnya.
create function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from ar_payments where invoice_id = p_invoice_id
      ), 0)
    - coalesce((
        select sum(amount) from ar_credit_notes where invoice_id = p_invoice_id
      ), 0)
    - coalesce((
        select sum(ada.amount) from ar_deposit_applications ada
        where ada.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    - coalesce((
        select sum(abw.amount) from ar_bad_debt_writeoffs abw
        where abw.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = abw.journal_entry_id
          )
      ), 0)
  from ar_invoices ai
  where ai.id = p_invoice_id;
$$ language sql stable;

-- 2 reducer: total return_credit_settled_amount (warranty_replacements yang credit_note_id-nya
-- match), refund tunai. Reducer "applications" (titip ke invoice lain) sudah dicabut.
create function ar_return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((
        select sum(wr.return_credit_settled_amount)
        from warranty_replacements wr
        where wr.credit_note_id = c.credit_note_id
      ), 0)
    - coalesce((select sum(amount) from ar_return_credit_refunds where credit_id = p_credit_id), 0)
  from ar_return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

-- ar_deposit_remaining (migration 0012) — sumber kebenaran tunggal sisa DP, dipakai ketiga
-- disposisi (applications/refunds/forfeitures) biar bisa campur bebas. Forfeitures & refunds
-- gak pernah punya jalur reversal (beda dari applications yang bisa di-unwind
-- cancel_ar_invoice), jadi SUM langsung tanpa exclude-reversed buat 2 reducer itu.
create function ar_deposit_remaining(p_deposit_id uuid) returns numeric as $$
  select ad.amount
    - coalesce((
        select sum(ada.amount) from ar_deposit_applications ada
        where ada.deposit_id = p_deposit_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
      ), 0)
    - coalesce((select sum(amount) from ar_deposit_refunds where deposit_id = p_deposit_id), 0)
    - coalesce((select sum(amount) from ar_deposit_forfeitures where deposit_id = p_deposit_id), 0)
  from ar_deposits ad
  where ad.id = p_deposit_id;
$$ language sql stable;

-- ar_deposit_applications_guard (migration 0012) — cek pakai ar_deposit_remaining() yang
-- udah nyakup applications+refunds+forfeitures sekaligus, gak ada lagi aturan "1 disposisi
-- aktif" (forfeiture gak lagi eksklusif sama application, ketiganya boleh campur).
create function ar_deposit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_deposit_customer_id uuid;
  v_invoice_customer_id uuid;
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_invoice_remaining numeric;
begin
  select ar_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Penerapan deposit % melebihi sisa deposit (sisa %, coba terapkan %)',
      new.deposit_id, v_remaining, new.amount;
  end if;

  select customer_id into v_deposit_customer_id from ar_deposits where id = new.deposit_id;
  select customer_id, journal_entry_id into v_invoice_customer_id, v_invoice_journal_entry_id
    from ar_invoices where id = new.invoice_id;

  if v_invoice_customer_id is distinct from v_deposit_customer_id then
    raise exception 'Deposit % milik customer lain — gak bisa diterapkan ke invoice %', new.deposit_id, new.invoice_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_invoice_journal_entry_id
  ) into v_invoice_cancelled;

  if v_invoice_cancelled then
    raise exception 'Invoice % udah dibatalkan — gak bisa diterapkan DP ke situ', new.invoice_id;
  end if;

  select ar_invoice_remaining(new.invoice_id) into v_invoice_remaining;

  if new.amount > v_invoice_remaining then
    raise exception 'Penerapan deposit ke invoice % melebihi sisa piutang (sisa %, coba terapkan %)',
      new.invoice_id, v_invoice_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_deposit_applications_guard_trigger
  before insert on ar_deposit_applications
  for each row execute function ar_deposit_applications_guard();

-- ar_deposit_forfeitures_guard (migration 0012) — sama pola, ganti 2 cek boolean lama
-- ("belum pernah hangus" + "gak ada application aktif") jadi 1 cek numerik lewat
-- ar_deposit_remaining().
create function ar_deposit_forfeitures_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select ar_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Forfeiture deposit % melebihi sisa deposit (sisa %, coba hanguskan %)',
      new.deposit_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_deposit_forfeitures_guard_trigger
  before insert on ar_deposit_forfeitures
  for each row execute function ar_deposit_forfeitures_guard();

-- Trigger baru (migration 0012) buat disposisi ar_deposit_refunds.
create function ar_deposit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select ar_deposit_remaining(new.deposit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Refund deposit % melebihi sisa deposit (sisa %, coba refund %)',
      new.deposit_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_deposit_refunds_guard_trigger
  before insert on ar_deposit_refunds
  for each row execute function ar_deposit_refunds_guard();

create function ar_bad_debt_writeoffs_no_over_writeoff() returns trigger as $$
declare
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_invoice_remaining numeric;
begin
  select journal_entry_id into v_invoice_journal_entry_id from ar_invoices where id = new.invoice_id;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_invoice_journal_entry_id
  ) into v_invoice_cancelled;

  if v_invoice_cancelled then
    raise exception 'Invoice % udah dibatalkan — gak bisa di-write-off', new.invoice_id;
  end if;

  select ar_invoice_remaining(new.invoice_id) into v_invoice_remaining;

  if new.amount > v_invoice_remaining then
    raise exception 'Write-off invoice % melebihi sisa outstanding riil (sisa %, coba write-off %)',
      new.invoice_id, v_invoice_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_bad_debt_writeoffs_no_over_writeoff_trigger
  before insert on ar_bad_debt_writeoffs
  for each row execute function ar_bad_debt_writeoffs_no_over_writeoff();

create function ar_return_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select ar_return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Refund saldo kredit retur % melebihi sisa saldo (sisa %, coba refund %)',
      new.credit_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_return_credit_refunds_guard_trigger
  before insert on ar_return_credit_refunds
  for each row execute function ar_return_credit_refunds_guard();

-- ============================================================
-- Kategori Campur & PPN (Compounding, migration 0025) —
-- memory/scope-debt/compound-transactional-entries.md +
-- memory/scope-debt/tax-handling.md (keduanya sudah dihapus, ditutup di sini).
-- ar_invoice_credit_lines: baris kredit aktual per invoice, kalau lebih dari 1 kategori.
-- ar_invoice_charge_types: katalog master data (dropdown kategori di form AR Invoice) —
-- gak ada FK ke ar_invoice_credit_lines, sama kayak item_units, murni resolve pilihan di
-- UI sebelum manggil RPC.
-- tax_settings: pengaturan PPN, tabel SINGLETON (id boolean primary key default true +
-- check(id), cuma bisa ada 1 baris selamanya) — DIPAKAI BARENG AP (0006_ap_schema.sql) &
-- POS (0009_pos_schema.sql), didefinisikan di sini karena AR modul pertama yang butuh
-- konsep ini. Tarif PPN itu aturan pemerintah (nasional), bukan per-transaksi — disimpan
-- di DB bukan di-hardcode di kode, biar ganti tarif cukup 1 UPDATE.
-- ============================================================

create table ar_invoice_credit_lines (
  id uuid primary key default gen_random_uuid(),
  ar_invoice_id uuid not null references ar_invoices(id) on delete cascade,
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false,
  created_at timestamptz not null default now()
);

create index ar_invoice_credit_lines_ar_invoice_id_idx on ar_invoice_credit_lines(ar_invoice_id);

create trigger ar_invoice_credit_lines_block_edit_delete
  before update or delete on ar_invoice_credit_lines
  for each row execute function block_edit_delete();

create table ar_invoice_charge_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_id uuid not null references accounts(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger ar_invoice_charge_types_set_updated_at
  before update on ar_invoice_charge_types
  for each row execute function set_updated_at();

create table tax_settings (
  id boolean primary key default true,
  is_active boolean not null default false,
  ppn_rate numeric(5,2) not null default 11 check (ppn_rate >= 0),
  ppn_keluaran_account_id uuid references accounts(id),
  ppn_masukan_account_id uuid references accounts(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint tax_settings_singleton check (id)
);

create trigger tax_settings_set_updated_at
  before update on tax_settings
  for each row execute function set_updated_at();

-- ============================================================
-- RPC
-- ============================================================

-- Credit hold: nolak invoice baru kalau customer kelampaui credit_limit ATAU ada invoice
-- open yang overdue lebih dari overdue_threshold_days-nya. NULL di kedua kolom = batas itu
-- gak berlaku. Batas waktu retur (yang pernah divalidasi di sini juga) sudah dicabut total.
-- Sisi kredit sekarang array (p_credit_lines, migration 0025) — bisa dipecah beberapa
-- kategori pendapatan dalam 1 invoice yang sama. Sisi debit (Piutang Usaha) TETAP 1 baris.
-- PPN (p_apply_tax) dihitung server-side dari tax_settings, gak pernah dari input klien.
create function create_ar_invoice(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_credit_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- kategori pendapatan, BUKAN termasuk PPN
  p_receivable_account_id uuid,
  p_apply_tax boolean default false
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_invoice_id uuid;
  v_credit_limit numeric;
  v_overdue_threshold_days int;
  v_outstanding numeric;
  v_max_overdue_days int;
  v_line jsonb;
  v_line_amount numeric;
  v_subtotal numeric := 0;
  v_tax_amount numeric := 0;
  v_total_amount numeric;
  v_tax_active boolean;
  v_tax_rate numeric;
  v_tax_account_id uuid;
  v_journal_lines jsonb;
begin
  if p_credit_lines is null or jsonb_array_length(p_credit_lines) = 0 then
    raise exception 'AR invoice wajib punya minimal 1 baris kredit';
  end if;

  select payment_term_days, credit_limit, overdue_threshold_days
    into v_term_days, v_credit_limit, v_overdue_threshold_days
    from customers where id = p_customer_id;
  v_due_date := p_invoice_date + v_term_days;

  for v_line in select * from jsonb_array_elements(p_credit_lines)
  loop
    v_line_amount := (v_line->>'amount')::numeric;
    if v_line_amount <= 0 then
      raise exception 'Nominal baris kredit harus > 0';
    end if;
    v_subtotal := v_subtotal + v_line_amount;
  end loop;

  if p_apply_tax then
    select is_active, ppn_rate, ppn_keluaran_account_id
      into v_tax_active, v_tax_rate, v_tax_account_id
      from tax_settings where id = true;

    if not coalesce(v_tax_active, false) then
      raise exception 'PPN gak aktif di Pengaturan Pajak -- gak bisa nambah baris PPN Keluaran';
    end if;
    if v_tax_account_id is null then
      raise exception 'Akun PPN Keluaran belum diset di Pengaturan Pajak';
    end if;

    v_tax_amount := round(v_subtotal * v_tax_rate / 100, 2);
  end if;

  v_total_amount := v_subtotal + v_tax_amount;

  select coalesce(sum(greatest(r.remaining, 0)), 0),
         coalesce(max(p_invoice_date - ai.due_date), 0)
    into v_outstanding, v_max_overdue_days
    from ar_invoices ai
    cross join lateral (select ar_invoice_remaining(ai.id) as remaining) r
    where ai.customer_id = p_customer_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ai.journal_entry_id
      )
      and r.remaining > 0;

  if v_credit_limit is not null and (v_outstanding + v_total_amount) > v_credit_limit then
    raise exception 'Customer kena credit hold: piutang outstanding % + invoice baru % ngelewatin credit_limit %',
      v_outstanding, v_total_amount, v_credit_limit;
  end if;

  if v_overdue_threshold_days is not null and v_max_overdue_days > v_overdue_threshold_days then
    raise exception 'Customer kena credit hold: ada piutang telat % hari (toleransi % hari)',
      v_max_overdue_days, v_overdue_threshold_days;
  end if;

  v_journal_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_total_amount, 'credit', 0)
  );

  for v_line in select * from jsonb_array_elements(p_credit_lines)
  loop
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', 0, 'credit', (v_line->>'amount')::numeric)
    );
  end loop;

  if p_apply_tax then
    v_journal_lines := v_journal_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax_account_id, 'debit', 0, 'credit', v_tax_amount)
    );
  end if;

  v_entry_id := create_journal_entry(p_invoice_date, p_description, p_source_ref, v_journal_lines);

  insert into ar_invoices (customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_customer_id, p_invoice_date, v_due_date, p_description, p_source_ref, v_total_amount, v_entry_id, auth.uid())
  returning id into v_invoice_id;

  for v_line in select * from jsonb_array_elements(p_credit_lines)
  loop
    insert into ar_invoice_credit_lines (ar_invoice_id, account_id, amount, is_tax)
    values (v_invoice_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
  end loop;

  if p_apply_tax then
    insert into ar_invoice_credit_lines (ar_invoice_id, account_id, amount, is_tax)
    values (v_invoice_id, v_tax_account_id, v_tax_amount, true);
  end if;

  return v_invoice_id;
end;
$$;

-- record_ar_payment (migration 0010) — boleh CICIL (kurang dari sisa outstanding), tapi
-- tetap gak boleh overpay (lebih dari sisa) dan tetap wajib nunjuk ke 1 invoice spesifik.
create function record_ar_payment(
  p_customer_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_receivable_account_id uuid,
  p_invoice_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_remaining numeric;
  v_entry_id uuid;
  v_payment_id uuid;
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining;

  if p_amount > v_remaining then
    raise exception 'Payment % melebihi sisa piutang invoice % (sisa %, coba bayar %) -- gak boleh overpay',
      p_source_ref, p_invoice_id, v_remaining, p_amount;
  end if;

  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan piutang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_payments (customer_id, invoice_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_customer_id, p_invoice_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

create function cancel_ar_invoice(
  p_invoice_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_paid_count int;
  v_written_off_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
begin
  select count(*) into v_paid_count
  from ar_payments where invoice_id = p_invoice_id;

  if v_paid_count > 0 then
    raise exception 'Invoice % udah punya payment — gak bisa dibatalkan lewat jalur ini', p_invoice_id;
  end if;

  select count(*) into v_written_off_count
  from ar_bad_debt_writeoffs where invoice_id = p_invoice_id;

  if v_written_off_count > 0 then
    raise exception 'Invoice % udah punya % write-off piutang tak tertagih — gak bisa dibatalkan lewat jalur ini', p_invoice_id, v_written_off_count;
  end if;

  select journal_entry_id into v_original_entry_id from ar_invoices where id = p_invoice_id;

  v_new_entry_id := reverse_journal_entry(v_original_entry_id, p_entry_date, p_source_ref);

  for v_application in
    select ada.journal_entry_id
    from ar_deposit_applications ada
    where ada.invoice_id = p_invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

-- create_ar_credit_note (migration 0015 — Kerugian Barang Rusak) — p_lines null/kosong ->
-- jalur financial-only (1 jurnal). p_lines terisi -> jalur full (2+ jurnal + stok balik),
-- invoice WAJIB punya goods_issue. Tiap baris retur jalur full sekarang punya `condition`:
-- RESALABLE (default, balik masuk stok) atau DAMAGED (gak balik masuk stok, cost-nya
-- direklasifikasi jadi Beban Kerugian Barang Rusak, p_loss_expense_account_id). Kontra-
-- revenue (Piutang Usaha) gak kepengaruh condition. Kalau retur ini bikin outstanding
-- invoice jadi minus, excess-nya otomatis "dicairkan" jadi ar_return_credits. Batas waktu
-- retur yang pernah divalidasi di sini sudah dicabut total.
create function create_ar_credit_note(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null, -- array of {"item_id":uuid,"qty_returned":numeric,"condition":text}
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null,
  p_loss_expense_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_credit_note_id uuid;
  v_goods_issue_id uuid;
  v_line jsonb;
  v_item_id uuid;
  v_qty_returned numeric;
  v_qty_issued numeric;
  v_total_cost numeric;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_condition text;
  v_total_cost_returned numeric := 0;
  v_total_cost_resalable numeric := 0;
  v_total_cost_damaged numeric := 0;
  v_qty_before numeric;
  v_avg_before numeric;
  v_hpp_entry_id uuid;
  v_hpp_journal_lines jsonb := '[]'::jsonb;
  v_return_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  v_line_conditions text[] := '{}';
  i int;
  v_remaining_before numeric;
  v_excess numeric;
  v_customer_id uuid;
  v_return_credit_entry_id uuid;
begin
  select ar_invoice_remaining(p_invoice_id) into v_remaining_before;

  v_entry_id := create_journal_entry(
    p_credit_note_date, 'Retur barang', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_credit_notes (invoice_id, credit_note_date, source_ref, amount, journal_entry_id, created_by)
  values (p_invoice_id, p_credit_note_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_credit_note_id;

  v_excess := greatest(0, p_amount - greatest(0, v_remaining_before));

  if v_excess > 0 then
    if p_return_credit_liability_account_id is null then
      raise exception 'Retur % bikin outstanding invoice jadi minus (excess %) — wajib isi p_return_credit_liability_account_id',
        p_source_ref, v_excess;
    end if;

    select customer_id into v_customer_id from ar_invoices where id = p_invoice_id;

    v_return_credit_entry_id := create_journal_entry(
      p_credit_note_date, 'Saldo kredit dari retur', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_excess, 'credit', 0),
        jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', 0, 'credit', v_excess)
      )
    );

    insert into ar_return_credits (customer_id, credit_note_id, amount, journal_entry_id, created_by)
    values (v_customer_id, v_credit_note_id, v_excess, v_return_credit_entry_id, auth.uid());
  end if;

  if p_lines is not null and jsonb_array_length(p_lines) > 0 then
    select id into v_goods_issue_id from goods_issues where invoice_id = p_invoice_id;

    if v_goods_issue_id is null then
      raise exception 'Invoice % gak punya goods_issue — gak bisa retur stok/HPP', p_invoice_id;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_item_id := (v_line->>'item_id')::uuid;
      v_qty_returned := (v_line->>'qty_returned')::numeric;
      v_condition := coalesce(v_line->>'condition', 'RESALABLE');

      if v_condition not in ('RESALABLE', 'DAMAGED') then
        raise exception 'condition % gak valid -- harus RESALABLE atau DAMAGED', v_condition;
      end if;

      select qty_issued, total_cost into v_qty_issued, v_total_cost
        from goods_issue_lines
        where goods_issue_id = v_goods_issue_id and item_id = v_item_id;

      if not found then
        raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', v_item_id, v_goods_issue_id;
      end if;

      v_unit_cost := v_total_cost / v_qty_issued;
      v_line_cost := v_qty_returned * v_unit_cost;
      v_total_cost_returned := v_total_cost_returned + v_line_cost;

      if v_condition = 'RESALABLE' then
        v_total_cost_resalable := v_total_cost_resalable + v_line_cost;

        select qty_on_hand, avg_cost into v_qty_before, v_avg_before
          from inventory_balances where item_id = v_item_id;

        update inventory_balances
          set qty_on_hand = v_qty_before + v_qty_returned,
              avg_cost = (v_qty_before * v_avg_before + v_qty_returned * v_unit_cost) / (v_qty_before + v_qty_returned),
              updated_at = now()
          where item_id = v_item_id;
      else
        v_total_cost_damaged := v_total_cost_damaged + v_line_cost;
      end if;

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
      v_line_conditions := array_append(v_line_conditions, v_condition);
    end loop;

    if v_total_cost_damaged > 0 and p_loss_expense_account_id is null then
      raise exception 'Ada baris retur DAMAGED (total cost %) -- wajib isi p_loss_expense_account_id',
        v_total_cost_damaged;
    end if;

    if v_total_cost_resalable > 0 then
      v_hpp_journal_lines := v_hpp_journal_lines ||
        jsonb_build_object('account_id', p_finished_good_account_id, 'debit', v_total_cost_resalable, 'credit', 0);
    end if;

    if v_total_cost_damaged > 0 then
      v_hpp_journal_lines := v_hpp_journal_lines ||
        jsonb_build_object('account_id', p_loss_expense_account_id, 'debit', v_total_cost_damaged, 'credit', 0);
    end if;

    v_hpp_journal_lines := v_hpp_journal_lines ||
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', 0, 'credit', v_total_cost_returned);

    v_hpp_entry_id := create_journal_entry(
      p_credit_note_date, 'Reversal HPP retur', p_source_ref, v_hpp_journal_lines
    );

    insert into inventory_returns (credit_note_id, goods_issue_id, journal_entry_id, return_date, source_ref, created_by)
    values (v_credit_note_id, v_goods_issue_id, v_hpp_entry_id, p_credit_note_date, p_source_ref, auth.uid())
    returning id into v_return_id;

    for i in 1..array_length(v_line_items, 1) loop
      insert into inventory_return_lines (inventory_return_id, item_id, qty_returned, total_cost, condition)
      values (v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i], v_line_conditions[i]);
    end loop;
  end if;

  return v_credit_note_id;
end;
$$;

create function create_ar_deposit(
  p_customer_id uuid,
  p_deposit_date date,
  p_source_ref text,
  p_amount numeric,
  p_cash_account_id uuid,
  p_deposit_liability_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_deposit_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_deposit_date, 'Uang muka diterima', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_deposit_liability_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_deposits (customer_id, deposit_date, source_ref, amount, journal_entry_id, created_by)
  values (p_customer_id, p_deposit_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_deposit_id;

  return v_deposit_id;
end;
$$;

create function apply_ar_deposit(
  p_deposit_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_deposit_liability_account_id uuid,
  p_receivable_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_application_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_entry_date, 'Penerapan uang muka ke invoice', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_deposit_liability_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_deposit_applications (deposit_id, invoice_id, amount, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_invoice_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_application_id;

  return v_application_id;
end;
$$;

-- forfeit_ar_deposit (migration 0012) — signature baru nerima p_amount (boleh sebagian dari
-- ar_deposits.amount, gak wajib penuh lagi).
create function forfeit_ar_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_forfeiture_date date,
  p_source_ref text,
  p_deposit_liability_account_id uuid,
  p_other_revenue_account_id uuid
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
      jsonb_build_object('account_id', p_deposit_liability_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_other_revenue_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_deposit_forfeitures (deposit_id, amount, forfeiture_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_forfeiture_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_forfeiture_id;

  return v_forfeiture_id;
end;
$$;

-- refund_ar_deposit (migration 0012, RPC baru) — mirror forfeit_ar_deposit, lawan jurnal
-- Kas bukan Pendapatan Lain-lain.
create function refund_ar_deposit(
  p_deposit_id uuid,
  p_amount numeric,
  p_refund_date date,
  p_source_ref text,
  p_deposit_liability_account_id uuid,
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
    p_refund_date, 'Refund uang muka', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_deposit_liability_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_deposit_refunds (deposit_id, amount, refund_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_amount, p_refund_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

-- Direct write-off method (bukan allowance/cadangan) — 1 kejadian = 1 jurnal.
create function write_off_ar_invoice(
  p_invoice_id uuid,
  p_writeoff_date date,
  p_amount numeric,
  p_source_ref text,
  p_expense_account_id uuid,
  p_receivable_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_entry_id uuid;
  v_writeoff_id uuid;
begin
  v_entry_id := create_journal_entry(
    p_writeoff_date, 'Piutang tak tertagih (write-off)', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_expense_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_bad_debt_writeoffs (invoice_id, writeoff_date, source_ref, amount, journal_entry_id, created_by)
  values (p_invoice_id, p_writeoff_date, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_writeoff_id;

  return v_writeoff_id;
end;
$$;

create function refund_ar_return_credit(
  p_credit_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_return_credit_liability_account_id uuid,
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
    p_entry_date, 'Refund saldo kredit retur customer', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_return_credit_refunds (credit_id, amount, source_ref, journal_entry_id, created_by)
  values (p_credit_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

-- Wajib credit_note jalur full (punya inventory_returns). Kalau credit note ini punya
-- ar_return_credits aktif (retur yang bikin outstanding invoice jadi minus), porsi
-- pembalikan diskon yang overlap disettle otomatis lewat p_return_credit_liability_account_id
-- (wajib diisi kalau overlap-nya > 0) — bukan lagi bisa "dititip" ke invoice lain.
create function create_warranty_replacement(
  p_credit_note_id uuid,
  p_replacement_date date,
  p_source_ref text,
  p_lines jsonb, -- array of {"item_id":uuid,"qty":numeric}
  p_hpp_account_id uuid,
  p_finished_good_account_id uuid,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_return_credit_liability_account_id uuid default null
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
  v_reversal_entry_id uuid := null;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
  i int;
  v_credit_note_amount numeric;
  v_total_returned_cost numeric;
  v_orig_qty_returned numeric;
  v_orig_total_cost numeric;
  v_reversal_share_cost numeric := 0;
  v_reversal_amount numeric;
  v_return_credit_id uuid;
  v_return_credit_remaining numeric;
  v_settlement_amount numeric := 0;
  v_settlement_entry_id uuid := null;
begin
  if not exists (select 1 from inventory_returns where credit_note_id = p_credit_note_id) then
    raise exception 'Credit note % financial-only (gak ada retur fisik) — gak bisa bikin penukaran barang', p_credit_note_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'Penukaran barang butuh minimal 1 baris item';
  end if;

  select amount into v_credit_note_amount from ar_credit_notes where id = p_credit_note_id;

  select coalesce(sum(irl.total_cost), 0) into v_total_returned_cost
    from inventory_return_lines irl
    join inventory_returns ir on ir.id = irl.inventory_return_id
    where ir.credit_note_id = p_credit_note_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_item_id := (v_line->>'item_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    v_line_cost := consume_weighted_average(v_item_id, v_qty);

    v_line_items := array_append(v_line_items, v_item_id);
    v_line_qtys := array_append(v_line_qtys, v_qty);
    v_line_costs := array_append(v_line_costs, v_line_cost);
    v_total_cost := v_total_cost + v_line_cost;

    select irl.qty_returned, irl.total_cost into v_orig_qty_returned, v_orig_total_cost
      from inventory_return_lines irl
      join inventory_returns ir on ir.id = irl.inventory_return_id
      where ir.credit_note_id = p_credit_note_id and irl.item_id = v_item_id;

    if not found then
      raise exception 'Item % gak ada di retur credit note %, gak bisa ditukar', v_item_id, p_credit_note_id;
    end if;

    v_reversal_share_cost := v_reversal_share_cost + (v_qty * (v_orig_total_cost / v_orig_qty_returned));
  end loop;

  v_entry_id := create_journal_entry(
    p_replacement_date, 'Penukaran barang pasca-retur/garansi', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_hpp_account_id, 'debit', v_total_cost, 'credit', 0),
      jsonb_build_object('account_id', p_finished_good_account_id, 'debit', 0, 'credit', v_total_cost)
    )
  );

  v_reversal_amount := round(v_credit_note_amount * v_reversal_share_cost / v_total_returned_cost, 2);

  if v_reversal_amount > 0 then
    -- Cek dulu SEBELUM bikin jurnal apa pun (fail-fast) — kalau credit note ini punya
    -- ar_return_credits aktif, porsi diskon yang mau dibalik gak boleh ngelebihin sisa
    -- saldonya. Sebagian saldo itu bisa aja udah kadung direfund tunai duluan
    -- (refund_ar_return_credit) — duitnya udah beneran keluar dan gak bisa "ditarik balik",
    -- jadi porsi reversal yang ngelebihin sisa saldo ditolak, bukan di-least()-kan diam-diam.
    select id into v_return_credit_id from ar_return_credits where credit_note_id = p_credit_note_id;

    if v_return_credit_id is not null then
      select ar_return_credit_remaining(v_return_credit_id) into v_return_credit_remaining;

      if v_reversal_amount > v_return_credit_remaining then
        raise exception 'Pembalikan diskon retur % (porsi %) melebihi sisa saldo kredit retur (sisa %) — sebagian saldo ini kemungkinan udah direfund tunai duluan, gak bisa direversal penuh lewat penukaran barang. Selesaikan sisa saldo kredit retur yang bentrok dulu, atau kurangi qty yang ditukar di panggilan ini.',
          p_credit_note_id, v_reversal_amount, v_return_credit_remaining;
      end if;

      if p_return_credit_liability_account_id is null then
        raise exception 'Credit note % punya saldo kredit retur aktif (sisa %) — wajib isi p_return_credit_liability_account_id buat settle via barang',
          p_credit_note_id, v_return_credit_remaining;
      end if;

      v_settlement_amount := v_reversal_amount;
    end if;

    v_reversal_entry_id := create_journal_entry(
      p_replacement_date, 'Pembalikan diskon retur — barang ditukar, bukan didiskon', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_receivable_account_id, 'debit', v_reversal_amount, 'credit', 0),
        jsonb_build_object('account_id', p_contra_revenue_account_id, 'debit', 0, 'credit', v_reversal_amount)
      )
    );

    if v_settlement_amount > 0 then
      v_settlement_entry_id := create_journal_entry(
        p_replacement_date, 'Penyelesaian saldo kredit retur via barang pengganti', p_source_ref,
        jsonb_build_array(
          jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', v_settlement_amount, 'credit', 0),
          jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', v_settlement_amount)
        )
      );
    end if;
  end if;

  insert into warranty_replacements (
    id, credit_note_id, replacement_date, source_ref, journal_entry_id,
    discount_reversed_amount, discount_reversal_journal_entry_id,
    return_credit_settled_amount, return_credit_settlement_journal_entry_id, created_by
  )
  values (
    v_replacement_id, p_credit_note_id, p_replacement_date, p_source_ref, v_entry_id,
    v_reversal_amount, v_reversal_entry_id,
    v_settlement_amount, v_settlement_entry_id, auth.uid()
  );

  for i in 1..array_length(v_line_items, 1) loop
    insert into warranty_replacement_lines (warranty_replacement_id, item_id, qty_replaced, total_cost)
    values (v_replacement_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
  end loop;

  return v_replacement_id;
end;
$$;

-- ============================================================
-- Seed — akun baru buat Kerugian Barang Rusak (migration 0017 pra-squash), dipakai bareng
-- kedua sisi — baris RESALABLE/DAMAGED di AR Credit Note (di atas), dan Opsi C
-- (create_purchase_writeoff) di AP (0006_ap_schema.sql). Plus akun PPN Keluaran/Masukan
-- (dipakai tax_settings di atas + AP), seed baris tunggal tax_settings-nya sendiri.
-- ============================================================

insert into accounts (code, name, category) values
  ('5900', 'Beban Kerugian Barang Rusak', 'expense'),
  ('1500', 'PPN Masukan', 'asset'),
  ('2400', 'PPN Keluaran', 'liability');

-- is_active=false (kios CV Roti Barokah belum PKP di cerita saat ini).
insert into tax_settings (id, is_active, ppn_rate, ppn_keluaran_account_id, ppn_masukan_account_id)
select true, false, 11,
  (select id from accounts where code = '2400'),
  (select id from accounts where code = '1500');

-- ============================================================
-- FK lintas-modul (deferred dari 0004_inventory_schema.sql — lihat catatan di sana)
-- ============================================================

alter table goods_issues
  add constraint goods_issues_invoice_id_fkey foreign key (invoice_id) references ar_invoices(id);

alter table sales_orders
  add constraint sales_orders_customer_id_fkey foreign key (customer_id) references customers(id);

-- ============================================================
-- RLS Policy
-- ============================================================

alter table customers enable row level security;

create policy customers_select on customers
  for select using (auth.role() = 'authenticated');

create policy customers_insert on customers
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

create policy customers_update on customers
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy DELETE -> arsip lewat archived_at, hard delete tertutup total

alter table ar_invoices enable row level security;

create policy ar_invoices_select on ar_invoices
  for select using (auth.role() = 'authenticated');

create policy ar_invoices_insert on ar_invoices
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_payments enable row level security;

create policy ar_payments_select on ar_payments
  for select using (auth.role() = 'authenticated');

create policy ar_payments_insert on ar_payments
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_credit_notes enable row level security;

create policy ar_credit_notes_select on ar_credit_notes
  for select using (auth.role() = 'authenticated');

create policy ar_credit_notes_insert on ar_credit_notes
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table inventory_returns enable row level security;

create policy inventory_returns_select on inventory_returns
  for select using (auth.role() = 'authenticated');

create policy inventory_returns_insert on inventory_returns
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table inventory_return_lines enable row level security;

create policy inventory_return_lines_select on inventory_return_lines
  for select using (auth.role() = 'authenticated');

create policy inventory_return_lines_insert on inventory_return_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_deposits enable row level security;

create policy ar_deposits_select on ar_deposits
  for select using (auth.role() = 'authenticated');

create policy ar_deposits_insert on ar_deposits
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_deposit_applications enable row level security;

create policy ar_deposit_applications_select on ar_deposit_applications
  for select using (auth.role() = 'authenticated');

create policy ar_deposit_applications_insert on ar_deposit_applications
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_deposit_forfeitures enable row level security;

create policy ar_deposit_forfeitures_select on ar_deposit_forfeitures
  for select using (auth.role() = 'authenticated');

create policy ar_deposit_forfeitures_insert on ar_deposit_forfeitures
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_deposit_refunds enable row level security;

create policy ar_deposit_refunds_select on ar_deposit_refunds
  for select using (auth.role() = 'authenticated');

create policy ar_deposit_refunds_insert on ar_deposit_refunds
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_bad_debt_writeoffs enable row level security;

create policy ar_bad_debt_writeoffs_select on ar_bad_debt_writeoffs
  for select using (auth.role() = 'authenticated');

create policy ar_bad_debt_writeoffs_insert on ar_bad_debt_writeoffs
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_return_credits enable row level security;

create policy ar_return_credits_select on ar_return_credits
  for select using (auth.role() = 'authenticated');

create policy ar_return_credits_insert on ar_return_credits
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_return_credit_refunds enable row level security;

create policy ar_return_credit_refunds_select on ar_return_credit_refunds
  for select using (auth.role() = 'authenticated');

create policy ar_return_credit_refunds_insert on ar_return_credit_refunds
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table warranty_replacements enable row level security;

create policy warranty_replacements_select on warranty_replacements
  for select using (auth.role() = 'authenticated');

create policy warranty_replacements_insert on warranty_replacements
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table warranty_replacement_lines enable row level security;

create policy warranty_replacement_lines_select on warranty_replacement_lines
  for select using (auth.role() = 'authenticated');

create policy warranty_replacement_lines_insert on warranty_replacement_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di semua tabel transaksional AR di atas -> RLS
-- default deny + block_edit_delete

alter table ar_invoice_credit_lines enable row level security;

create policy ar_invoice_credit_lines_select on ar_invoice_credit_lines
  for select using (auth.role() = 'authenticated');

create policy ar_invoice_credit_lines_insert on ar_invoice_credit_lines
  for insert with check (
    exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

-- ar_invoice_charge_types: katalog master data, select semua authenticated, insert+update
-- admin doang (owner yang setup katalog). Gak ada delete -- nonaktifkan pakai archived_at.
alter table ar_invoice_charge_types enable row level security;

create policy ar_invoice_charge_types_select on ar_invoice_charge_types for select using (auth.role() = 'authenticated');
create policy ar_invoice_charge_types_insert on ar_invoice_charge_types for insert with check (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);
create policy ar_invoice_charge_types_update on ar_invoice_charge_types for update using (
  exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role_name = 'admin')
);

-- tax_settings: select semua authenticated, update admin doang. Sengaja gak ada policy
-- INSERT/DELETE -- baris tunggalnya cuma diseed migration ini, admin cuma boleh UPDATE
-- nilai yang sudah ada (constraint singleton nolak baris kedua walau ada yang nekat insert).
alter table tax_settings enable row level security;

create policy tax_settings_select on tax_settings
  for select using (auth.role() = 'authenticated');

create policy tax_settings_update on tax_settings
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

-- ============================================================
-- Grant
-- ============================================================

grant select, insert, update on customers to authenticated;
grant select, insert on ar_invoices to authenticated;
grant select, insert on ar_payments to authenticated;
grant select, insert on ar_credit_notes to authenticated;
grant select, insert on inventory_returns to authenticated;
grant select, insert on inventory_return_lines to authenticated;
grant select, insert on ar_deposits to authenticated;
grant select, insert on ar_deposit_applications to authenticated;
grant select, insert on ar_deposit_forfeitures to authenticated;
grant select, insert on ar_deposit_refunds to authenticated;
grant select, insert on ar_bad_debt_writeoffs to authenticated;
grant select, insert on ar_return_credits to authenticated;
grant select, insert on ar_return_credit_refunds to authenticated;
grant select, insert on warranty_replacements to authenticated;
grant select, insert on warranty_replacement_lines to authenticated;
grant select, insert on ar_invoice_credit_lines to authenticated;
grant select, insert, update on ar_invoice_charge_types to authenticated;
grant select, update on tax_settings to authenticated;
