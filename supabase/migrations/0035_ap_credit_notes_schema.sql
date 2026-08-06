-- Fase 4 (AP) lanjutan — AP Credit Note (Retur Barang ke Supplier).
-- Ref bisnis: docs/domain/accounts-payable.md bagian "Retur Barang ke Supplier".
-- Ref ERD+DDL humanable: docs/architecture/ap-schema.md (menyusul).
-- Reuse: create_journal_entry() (0004), block_edit_delete() (0004),
--        consume_weighted_average() (0012). 0 perubahan ke ap_bills/ap_payments/suppliers.
--
-- Beda mendasar dari AR Credit Note (ar_credit_notes, 0021): 2 resolusi retur yang
-- SALING EKSKLUSIF, bukan additive kayak AR (lihat memory/scope-debt/
-- ar-warranty-replacement-kompensasi-ganda.md — gap yang baru ketauan di AR justru lewat
-- desain AP ini):
--   - Opsi A (create_ap_credit_note): kurangi Utang Usaha, TANPA akun kontra (Persediaan
--     itu akun neraca, boleh langsung dikurangi -- beda dari AR yang kontra-revenue).
--   - Opsi B (create_purchase_replacement): tukar barang, BERDIRI SENDIRI (gak lewat
--     ap_credit_notes sama sekali), Utang Usaha gak pernah kesentuh. Sengaja gak niru pola
--     warranty_replacement AR yang wajib nunjuk credit note dulu -- kalau AP niru itu,
--     supplier ngasih 2 kompensasi sekaligus (kurangi utang DAN ganti barang) untuk 1
--     kejadian rusak yang sama, gak masuk akal secara bisnis dari sisi supplier.
--
-- Asumsi sementara: cuma nanganin item WEIGHTED_AVERAGE (reuse consume_weighted_average).
-- Item FIFO diabaikan dulu -- memory/scope-debt/penghapusan-fifo.md (FIFO rencana dihapus
-- dari sistem, gak ada gunanya bikin mekanisme "konsumsi tertarget ke lot spesifik" buat
-- fitur yang bakal dibuang gak lama lagi).
--
-- Batas waktu retur (mirror return_window_days AR) SENGAJA gak termasuk dan gak akan
-- digarap (keputusan final, bukan scope-debt). Barang rusak yang gak dapat kompensasi sama
-- sekali (supplier nolak) juga di luar scope -- memory/scope-debt/kerugian-barang-rusak.md.

-- Akun COA baru "Piutang Retur Supplier" (1350) di-insert di migration seed (0036), pola
-- sama '2400 Saldo Kredit Customer' (0028)/'2500 Saldo Kredit Retur Customer' (0032) --
-- bukan di migration schema ini, biar konsisten sama semua fitur lain (environment yang
-- cuma apply schema tanpa demo seed gak otomatis dapet akun ini).

-- ============================================================
-- Tabel: ap_credit_notes (Opsi A -- selalu dibuat kalau resolusinya "kurangi utang")
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

-- No-over-return (level Rp, terhadap nilai bill) -- cap-nya ke ap_bills.amount, BUKAN sisa
-- outstanding, karena retur independen dari status bayar (pola sama ar_credit_notes_no_over_return).
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

-- ============================================================
-- Tabel: purchase_return_lines (rincian item Opsi A, cuma kalau bill full/item-tracked --
-- ada goods_receipt_notes). Beda dari inventory_returns/inventory_return_lines di AR: gak
-- butuh tabel header terpisah (inventory_returns) karena purchase_return_lines gak perlu
-- disebut balik oleh mekanisme lain (Opsi B berdiri sendiri, gak nunjuk ke sini) -- cukup
-- FK langsung ke ap_credit_notes.
-- ============================================================

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
-- Tabel: purchase_replacements + purchase_replacement_lines (Opsi B -- tukar barang,
-- BERDIRI SENDIRI, gak lewat ap_credit_notes sama sekali).
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
-- purchase_returned_qty(bill_id, item_id) -- total qty yang udah "diklaim" dari 1 item di
-- 1 bill, GABUNGAN Opsi A (purchase_return_lines) + Opsi B (purchase_replacement_lines).
-- Guard no-over-return per item pakai fungsi ini -- fisiknya cuma ada 1 pool qty_received
-- yang bisa diklaim, mau lewat jalur mana pun (kurangi utang atau tukar barang), gak boleh
-- kelebihan gabungan keduanya. Item FIFO otomatis kejaga trigger per-lot yang udah ada
-- (inventory_lot_consumptions_no_over_consumption) -- item WEIGHTED_AVERAGE gak punya
-- proteksi itu (stoknya udah nyampur), makanya guard eksplisit ini dibutuhkan.
-- ============================================================

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
-- Tabel: ap_return_credits + ap_return_credit_applications + ap_return_credit_refunds
-- (mirror ar_return_credits/0031, arah asset kebalik -- di AR liability kita ke customer,
-- di sini asset kita ke supplier).
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
-- ap_bill_remaining(bill_id) -- sisa outstanding riil 1 bill (amount dikurangi payment
-- allocation + credit note + return-credit application AKTIF). Disentralisasi dari AWAL
-- (beda dari AR yang baru disentralisasi belakangan di 0031 setelah kebukti perlu lewat
-- bug berulang) -- pelajaran langsung dipakai di sini karena polanya udah kenal. 3
-- reducer, bukan 2 -- ap_return_credit_applications WAJIB ikut dihitung di sini (bukan
-- cuma di ap_return_credit_applications_guard) karena dia beneran ngurangin Utang Usaha
-- bill target-nya; kalau kelewat, ap_payment_allocations_no_over_allocation di bawah bisa
-- kealokasiin payment ngelebihin sisa riil pada bill yang udah sebagian "dibayar" pakai
-- saldo kredit retur -- kelas bug yang sama persis yang coba dicegah refactor ini.
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

-- ap_payment_allocations_no_over_allocation (0010) -- DIPERBARUI pakai ap_bill_remaining()
-- alih-alih ngitung langsung dari ap_bills.amount. Tanpa ini, bill yang udah diretur bisa
-- kealokasiin payment ngelebihin sisa riil -- kelas bug persis yang ditemukan di AR (0031)
-- sebelum ar_invoice_remaining() ada. Diperbaiki dari awal, bukan ditunggu kebukti lagi.
create or replace function ap_payment_allocations_no_over_allocation() returns trigger as $$
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

-- ============================================================
-- ap_return_credit_remaining(credit_id) -- pola identik ar_return_credit_remaining (0031).
-- ============================================================

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
-- cancel_ap_bill (0010) -- DIPERBARUI: 2 hal baru yang bisa nempel ke bill sekarang harus
-- ditangani, mirror persis perluasan cancel_ar_invoice pas ar_return_credit_applications
-- ditambahkan (0031) -- migration yang nambah reducer baru WAJIB langsung revisit RPC
-- cancel yang berkaitan, jangan ditunda sampai kebukti bug (ketauan pas schema-reviewer).
--   1. Bill yang udah punya ap_credit_notes (pernah diretur) -- DITOLAK KERAS, pola sama
--      guard ap_payment_allocations (bill udah "kesentuh" transaksi lain, gak bisa
--      dianggap "gak pernah terjadi" lagi tanpa mikirin nasib retur yang udah dicatat).
--   2. Bill yang jadi TARGET ap_return_credit_applications (supplier lain punya saldo
--      kredit yang dipakai motong bill ini) -- AUTO-REVERSE jurnalnya, sama alasan
--      cancel_ar_invoice auto-unwind ar_return_credit_applications: reklasifikasi
--      sederhana, aman dibalik (beda dari kasus #1 yang keputusan bisnis, bukan reklas).
-- ============================================================
create or replace function cancel_ap_bill(
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

-- ============================================================
-- RPC: create_ap_credit_note (Opsi A -- kurangi Utang Usaha)
-- ============================================================
-- p_lines null/kosong -> jalur financial-only (1 jurnal, gak nyentuh inventory,
-- p_amount dipakai apa adanya -- caller yang tentuin nilainya).
-- p_lines terisi -> jalur full, bill WAJIB punya goods_receipt_notes, item WEIGHTED_AVERAGE
-- doang (FIFO diabaikan -- memory/scope-debt/penghapusan-fifo.md). p_amount DIABAIKAN dan
-- DIGANTI hasil penjumlahan cost fisik tiap baris (consume_weighted_average) -- beda dari
-- create_ar_credit_note yang sengaja punya 2 angka independen (harga jual vs cost, buat
-- kontra-revenue vs reversal HPP terpisah). Di sini cuma ADA 1 jurnal yang langsung
-- ngeKredit Persediaan, jadi nominalnya HARUS sama persis sama nilai barang yang beneran
-- keluar dari stok -- kalau p_amount dibiarkan independen, Persediaan di GL bisa
-- menyimpang dari inventory_balances tanpa ketauan trigger mana pun (ketauan pas
-- schema-reviewer, bukan disengaja dari awal). Konsekuensinya: urutan kerja jadi beda dari
-- create_ar_credit_note -- konsumsi stok WAJIB jalan duluan (buat tau total cost-nya)
-- sebelum jurnal & baris ap_credit_notes dibikin, bukan belakangan.
--
-- TANPA akun kontra (beda dari create_ar_credit_note yang kontra-revenue) -- Persediaan
-- itu akun neraca, boleh langsung dikurangi. p_credit_account_id generik (biasanya akun
-- yang sama dipakai create_ap_bill aslinya, Persediaan atau Beban), sama pola
-- p_debit_account_id di create_ap_bill -- caller yang tentuin, gak di-hardcode.
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

-- ============================================================
-- RPC: create_purchase_replacement (Opsi B -- tukar barang, BERDIRI SENDIRI)
-- ============================================================
-- Gak lewat ap_credit_notes, gak nyentuh Utang Usaha. Jurnal: Debit Persediaan (barang
-- baru) / Kredit Persediaan (barang rusak) -- akun yang SAMA di kedua baris, net nol,
-- murni reklasifikasi fisik buat jejak audit.
--
-- Mekanisme: barang rusak KELUAR (consume_weighted_average, sama fungsi dipakai Opsi A
-- jalur full), lalu barang baru MASUK pakai avg_cost yang sama persis (v_line_cost/qty)
-- -- karena unit cost-nya identik, hitung ulang rata-rata di langkah "masuk" otomatis
-- balik ke avg_cost semula (murni aljabar, bukan kebetulan) -- konsisten sama klaim
-- "net nol" di dokumentasi bisnis.
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

-- ============================================================
-- RPC: apply_ap_return_credit -- pakai saldo kredit retur motong bill lain
-- (Debit Utang Usaha / Kredit Piutang Retur Supplier).
-- ============================================================

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

-- ============================================================
-- RPC: refund_ap_return_credit -- refund tunai saldo kredit retur
-- (Debit Kas/Bank / Kredit Piutang Retur Supplier).
-- ============================================================

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
-- RLS Policy -- pola identik semua tabel transaksional AP/AR lain: select terbuka semua
-- authenticated, insert cuma admin/accountant, gak ada update/delete (immutability, RLS
-- default-deny + block_edit_delete jaring kedua).
-- ============================================================

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
-- sengaja gak ada policy UPDATE/DELETE di 7 tabel transaksional baru ini -> RLS default deny

-- ============================================================
-- Grant
-- ============================================================

grant select, insert on ap_credit_notes to authenticated;
grant select, insert on purchase_return_lines to authenticated;
grant select, insert on purchase_replacements to authenticated;
grant select, insert on purchase_replacement_lines to authenticated;
grant select, insert on ap_return_credits to authenticated;
grant select, insert on ap_return_credit_applications to authenticated;
grant select, insert on ap_return_credit_refunds to authenticated;
