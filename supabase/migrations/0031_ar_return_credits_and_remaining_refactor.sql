-- Fase 3 (AR) lanjutan — 2 hal digabung dalam 1 migration (saling terkait):
--
-- 1. Refactor: pusatkan "sisa outstanding riil 1 invoice" jadi 1 fungsi
--    ar_invoice_remaining(invoice_id), dipanggil semua guard/RPC yang sebelumnya
--    masing-masing menghitung ulang jumlah 5 reducer (ar_payment_allocations,
--    ar_credit_notes, ar_deposit_applications, ar_customer_credit_applications,
--    ar_bad_debt_writeoffs) sendiri-sendiri. Pola duplikasi ini yang bikin bug
--    berulang 2x (ketauan review) tiap kali reducer baru ditambah (0024, 0027) — reducer
--    baru gampang kelewat gak ikut ditambahin ke salah satu dari 5 tempat. Pola
--    sentralisasi ini udah ada presedennya: ar_customer_credit_remaining() (0027).
--
--    PENTING (ketauan pas schema-reviewer, bukan disengaja dari awal) — refactor ini
--    BUKAN murni "sama perilaku, beda struktur kode". Ditelusuri balik sampai 0007: 3 dari
--    5 fungsi lama (ar_payment_allocations_no_over_allocation, ar_deposit_applications_guard,
--    ar_customer_credit_applications_guard) PLUS create_ar_invoice punya gap yang gak
--    disadari — dari awal gak pernah ngurangin ar_credit_notes (retur) dari perhitungan
--    "sisa ruang" invoice (cuma ar_bad_debt_writeoffs_no_over_writeoff yang bener dari
--    0029). Efeknya: sebelum migration ini, payment/DP/customer-credit BISA dialokasikan
--    ngelebihin sisa riil kalau invoice-nya udah punya retur aktif — celah over-allocation
--    laten, kelas bug yang sama persis yang berulang di 0024/0027. Sekarang otomatis
--    kebenerin karena ar_invoice_remaining() konsisten ngitung ar_credit_notes buat SEMUA
--    caller. Gak ada data seed lama yang kena dampak (guard cuma nge-cek insert BARU,
--    bukan validasi ulang baris lama) — tapi dicatat eksplisit di sini biar gak
--    kesalahartiin sebagai efek samping gak sengaja.
--
-- 2. Fitur baru: AR Return Credit — retur yang bikin outstanding invoice jadi minus
--    (barang balik SETELAH invoice lunas) sekarang otomatis "dicairkan" jadi saldo resmi
--    yang bisa dipakai/direfund, pola sama persis AR Customer Credit (overpayment) tapi
--    beda akun karena beda asal jurnal (retur, bukan kelebihan kas). Ini jadi reducer
--    ke-6 yang otomatis masuk ar_invoice_remaining() sejak awal — gak nambah utang
--    teknis baru di atas refactor #1.
--
-- Ref bisnis: docs/domain/accounts-receivable.md bagian "Saldo Kredit dari Retur".
-- Ref ERD+DDL humanable: docs/architecture/ar-schema.md.
-- Akun COA baru (Saldo Kredit Retur Customer, kode 2500) di-insert di migration seed
-- (0032), pola sama '2400 Saldo Kredit Customer' (0028).

-- ============================================================
-- Tabel: ar_return_credits (saldo kredit lahir, selalu dari retur yang bikin outstanding
-- invoice jadi minus)
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

-- ============================================================
-- Tabel: ar_return_credit_applications (saldo kredit dipakai motong invoice lain)
-- ============================================================

create table ar_return_credit_applications (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ar_return_credits(id),
  invoice_id uuid not null references ar_invoices(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_return_credit_applications_credit_id_idx on ar_return_credit_applications(credit_id);
create index ar_return_credit_applications_invoice_id_idx on ar_return_credit_applications(invoice_id);

create trigger ar_return_credit_applications_block_edit_delete
  before update or delete on ar_return_credit_applications
  for each row execute function block_edit_delete();

-- ============================================================
-- Tabel: ar_return_credit_refunds (saldo kredit direfund tunai)
-- ============================================================

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
-- ar_invoice_remaining(invoice_id) — SUMBER KEBENARAN TUNGGAL buat "sisa outstanding
-- riil" 1 invoice: amount dikurangi SEMUA 6 reducer (payment allocation, retur, DP
-- application aktif, customer credit application aktif, write-off aktif, return credit
-- application aktif). "Aktif" = journal_entry_id-nya belum di-reverse — ar_payment_allocations
-- dan ar_credit_notes gak pernah punya reversal (dijamin trigger/guard existing), jadi
-- gak perlu exclude filter buat 2 itu.
--
-- STABLE (bukan VOLATILE) — cuma baca, boleh dipanggil berkali-kali dalam 1 query tanpa
-- efek samping, konsisten pola ar_customer_credit_remaining() (0027).
-- ============================================================

create function ar_invoice_remaining(p_invoice_id uuid) returns numeric as $$
  select ai.amount
    - coalesce((
        select sum(amount) from ar_payment_allocations where invoice_id = p_invoice_id
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
        select sum(aca.amount) from ar_customer_credit_applications aca
        where aca.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = aca.journal_entry_id
          )
      ), 0)
    - coalesce((
        select sum(abw.amount) from ar_bad_debt_writeoffs abw
        where abw.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = abw.journal_entry_id
          )
      ), 0)
    - coalesce((
        select sum(arca.amount) from ar_return_credit_applications arca
        where arca.invoice_id = p_invoice_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = arca.journal_entry_id
          )
      ), 0)
  from ar_invoices ai
  where ai.id = p_invoice_id;
$$ language sql stable;

-- ============================================================
-- ar_return_credit_remaining(credit_id) — pola identik ar_customer_credit_remaining (0027).
-- ============================================================

create function ar_return_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((
        select sum(arca.amount) from ar_return_credit_applications arca
        where arca.credit_id = p_credit_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = arca.journal_entry_id
          )
      ), 0)
    - coalesce((select sum(amount) from ar_return_credit_refunds where credit_id = p_credit_id), 0)
  from ar_return_credits c
  where c.id = p_credit_id;
$$ language sql stable;

-- ============================================================
-- Guard: ar_return_credit_refunds_guard — pola identik ar_customer_credit_refunds_guard.
-- ============================================================

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
-- Guard: ar_return_credit_applications_guard — pola identik
-- ar_customer_credit_applications_guard, tapi versi ini (dan 4 guard lain di bawah)
-- udah dipangkas jadi jauh lebih pendek karena tinggal manggil ar_invoice_remaining()
-- alih-alih menghitung ulang 6 reducer manual.
-- ============================================================

create function ar_return_credit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_credit_customer_id uuid;
  v_invoice_customer_id uuid;
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_invoice_remaining numeric;
begin
  select ar_return_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Pemakaian saldo kredit retur % melebihi sisa saldo (sisa %, coba pakai %)',
      new.credit_id, v_remaining, new.amount;
  end if;

  select customer_id into v_credit_customer_id from ar_return_credits where id = new.credit_id;
  select customer_id, journal_entry_id into v_invoice_customer_id, v_invoice_journal_entry_id
    from ar_invoices where id = new.invoice_id;

  if v_credit_customer_id is distinct from v_invoice_customer_id then
    raise exception 'Saldo kredit retur % milik customer lain — gak bisa dipakai motong invoice %', new.credit_id, new.invoice_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_invoice_journal_entry_id
  ) into v_invoice_cancelled;

  if v_invoice_cancelled then
    raise exception 'Invoice % udah dibatalkan — gak bisa diterapkan saldo kredit retur ke situ', new.invoice_id;
  end if;

  select ar_invoice_remaining(new.invoice_id) into v_invoice_remaining;

  if new.amount > v_invoice_remaining then
    raise exception 'Penerapan saldo kredit retur ke invoice % melebihi sisa piutang (sisa %, coba terapkan %)',
      new.invoice_id, v_invoice_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_return_credit_applications_guard_trigger
  before insert on ar_return_credit_applications
  for each row execute function ar_return_credit_applications_guard();

-- ============================================================
-- ar_payment_allocations_no_over_allocation (0007, di-extend 0024/0027/0029) —
-- DISEDERHANAKAN pakai ar_invoice_remaining(), bukan nambah reducer manual lagi.
-- ============================================================
create or replace function ar_payment_allocations_no_over_allocation() returns trigger as $$
declare
  v_invoice_remaining numeric;
  v_payment_amount numeric;
  v_payment_allocated numeric;
begin
  select ar_invoice_remaining(new.invoice_id) into v_invoice_remaining;

  if new.amount > v_invoice_remaining then
    raise exception 'Alokasi ke invoice % melebihi sisa piutang (sisa %, coba alokasi %)',
      new.invoice_id, v_invoice_remaining, new.amount;
  end if;

  select amount into v_payment_amount from ar_payments where id = new.payment_id;
  select coalesce(sum(amount), 0) into v_payment_allocated
    from ar_payment_allocations where payment_id = new.payment_id;

  if v_payment_allocated + new.amount > v_payment_amount then
    raise exception 'Alokasi dari payment % melebihi sisa yang belum teralokasi (sisa %, coba alokasi %)',
      new.payment_id, v_payment_amount - v_payment_allocated, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- ar_deposit_applications_guard (0024, di-extend 0027/0029) — disederhanakan sama.
-- ============================================================
create or replace function ar_deposit_applications_guard() returns trigger as $$
declare
  v_forfeited_count int;
  v_deposit_amount numeric;
  v_deposit_customer_id uuid;
  v_already_applied numeric;
  v_invoice_customer_id uuid;
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_invoice_remaining numeric;
begin
  select count(*) into v_forfeited_count
    from ar_deposit_forfeitures where deposit_id = new.deposit_id;

  if v_forfeited_count > 0 then
    raise exception 'Deposit % udah dihanguskan — gak bisa diterapkan ke invoice', new.deposit_id;
  end if;

  select amount, customer_id into v_deposit_amount, v_deposit_customer_id
    from ar_deposits where id = new.deposit_id;
  select coalesce(sum(ada.amount), 0) into v_already_applied
    from ar_deposit_applications ada
    where ada.deposit_id = new.deposit_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      );

  if v_already_applied + new.amount > v_deposit_amount then
    raise exception 'Penerapan deposit % melebihi sisa deposit (deposit %, sudah diterapkan %, coba terapkan %)',
      new.deposit_id, v_deposit_amount, v_already_applied, new.amount;
  end if;

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

-- ============================================================
-- ar_customer_credit_applications_guard (0027, di-extend 0029) — disederhanakan sama.
-- ============================================================
create or replace function ar_customer_credit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_credit_customer_id uuid;
  v_invoice_customer_id uuid;
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_invoice_remaining numeric;
begin
  select ar_customer_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Pemakaian saldo kredit % melebihi sisa saldo (sisa %, coba pakai %)',
      new.credit_id, v_remaining, new.amount;
  end if;

  select customer_id into v_credit_customer_id from ar_customer_credits where id = new.credit_id;
  select customer_id, journal_entry_id into v_invoice_customer_id, v_invoice_journal_entry_id
    from ar_invoices where id = new.invoice_id;

  if v_credit_customer_id is distinct from v_invoice_customer_id then
    raise exception 'Saldo kredit % milik customer lain — gak bisa dipakai motong invoice %', new.credit_id, new.invoice_id;
  end if;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_invoice_journal_entry_id
  ) into v_invoice_cancelled;

  if v_invoice_cancelled then
    raise exception 'Invoice % udah dibatalkan — gak bisa diterapkan saldo kredit ke situ', new.invoice_id;
  end if;

  select ar_invoice_remaining(new.invoice_id) into v_invoice_remaining;

  if new.amount > v_invoice_remaining then
    raise exception 'Penerapan saldo kredit ke invoice % melebihi sisa piutang (sisa %, coba terapkan %)',
      new.invoice_id, v_invoice_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- ar_bad_debt_writeoffs_no_over_writeoff (0029) — disederhanakan sama. Beda dari 4 guard
-- lain di atas: masih perlu cek invoice_cancelled sendiri (sama kayak sebelumnya).
-- ============================================================
create or replace function ar_bad_debt_writeoffs_no_over_writeoff() returns trigger as $$
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

-- ============================================================
-- create_ar_invoice (0007, di-extend 0020/0024/0027/0029) — outstanding buat credit hold
-- sekarang cuma jumlahin ar_invoice_remaining() per invoice open milik customer itu,
-- gantiin query union 4-cabang yang lama.
-- ============================================================
create or replace function create_ar_invoice(
  p_customer_id uuid,
  p_invoice_date date,
  p_description text,
  p_source_ref text,
  p_amount numeric,
  p_receivable_account_id uuid,
  p_revenue_account_id uuid
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
begin
  select payment_term_days, credit_limit, overdue_threshold_days
    into v_term_days, v_credit_limit, v_overdue_threshold_days
    from customers where id = p_customer_id;
  v_due_date := p_invoice_date + v_term_days;

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

  if v_credit_limit is not null and (v_outstanding + p_amount) > v_credit_limit then
    raise exception 'Customer kena credit hold: piutang outstanding % + invoice baru % ngelewatin credit_limit %',
      v_outstanding, p_amount, v_credit_limit;
  end if;

  if v_overdue_threshold_days is not null and v_max_overdue_days > v_overdue_threshold_days then
    raise exception 'Customer kena credit hold: ada piutang telat % hari (toleransi % hari)',
      v_max_overdue_days, v_overdue_threshold_days;
  end if;

  v_entry_id := create_journal_entry(
    p_invoice_date, p_description, p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_revenue_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_invoices (customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_by)
  values (p_customer_id, p_invoice_date, v_due_date, p_description, p_source_ref, p_amount, v_entry_id, auth.uid())
  returning id into v_invoice_id;

  return v_invoice_id;
end;
$$;

-- ============================================================
-- cancel_ar_invoice (0009, di-extend 0024/0027/0029) — diperluas lagi: ikut reverse
-- jurnal ar_return_credit_applications juga, simetris perluasan ar_deposit_applications
-- (0024) & ar_customer_credit_applications (0027) — reklasifikasi sederhana, aman
-- di-auto-unwind (beda dari ar_bad_debt_writeoffs yang ditolak keras, karena write-off
-- itu keputusan bisnis "gak akan tertagih", bukan reklasifikasi).
-- ============================================================
create or replace function cancel_ar_invoice(
  p_invoice_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_allocated_count int;
  v_written_off_count int;
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
  v_credit_application record;
  v_return_credit_application record;
begin
  select count(*) into v_allocated_count
  from ar_payment_allocations where invoice_id = p_invoice_id;

  if v_allocated_count > 0 then
    raise exception 'Invoice % udah punya % alokasi payment — gak bisa dibatalkan lewat jalur ini', p_invoice_id, v_allocated_count;
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

  for v_credit_application in
    select aca.journal_entry_id
    from ar_customer_credit_applications aca
    where aca.invoice_id = p_invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = aca.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_credit_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  for v_return_credit_application in
    select arca.journal_entry_id
    from ar_return_credit_applications arca
    where arca.invoice_id = p_invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = arca.journal_entry_id
      )
  loop
    perform reverse_journal_entry(v_return_credit_application.journal_entry_id, p_entry_date, p_source_ref);
  end loop;

  return v_new_entry_id;
end;
$$;

-- ============================================================
-- create_ar_credit_note (0021, bugfix 0022) — diperluas: kalau retur ini bikin
-- outstanding invoice jadi minus, otomatis "cairkan" excess-nya jadi ar_return_credits
-- (reklasifikasi: Debit Piutang Usaha / Kredit Saldo Kredit Retur Customer). Sisa
-- outstanding SEBELUM retur ini dihitung dari ar_invoice_remaining() SEBELUM baris
-- ar_credit_notes diinsert (fungsi baca state live, jadi harus dipanggil di urutan yang
-- tepat). excess = greatest(0, p_amount - greatest(0, v_remaining_before)) — cuma bagian
-- retur yang beneran "kelebihan" dari sisa yang ada, bukan seluruh nominal retur.
--
-- Parameter baru p_return_credit_liability_account_id ditaro PALING AKHIR dengan default
-- null (nullable, cuma wajib diisi kalau excess-nya > 0) — signature call existing (0023
-- seed) yang gak isi param ini tetep jalan tanpa perubahan. drop function if exists dulu
-- (signature lama 9 parameter) — pelajaran dari bug 0027 (nambah parameter ke_fungsi
-- existing lewat create or replace bikin overload baru kalau gak di-drop eksplisit dulu).
-- ============================================================

drop function if exists create_ar_credit_note(uuid, date, text, numeric, uuid, uuid, jsonb, uuid, uuid);

create or replace function create_ar_credit_note(
  p_invoice_id uuid,
  p_credit_note_date date,
  p_source_ref text,
  p_amount numeric,
  p_contra_revenue_account_id uuid,
  p_receivable_account_id uuid,
  p_lines jsonb default null, -- array of {"item_id":uuid,"qty_returned":numeric}
  p_hpp_account_id uuid default null,
  p_finished_good_account_id uuid default null,
  p_return_credit_liability_account_id uuid default null
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
  v_total_cost_returned numeric := 0;
  v_costing_method text;
  v_qty_before numeric;
  v_avg_before numeric;
  v_hpp_entry_id uuid;
  v_return_id uuid;
  v_line_items uuid[] := '{}';
  v_line_qtys numeric[] := '{}';
  v_line_costs numeric[] := '{}';
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

      select qty_issued, total_cost into v_qty_issued, v_total_cost
        from goods_issue_lines
        where goods_issue_id = v_goods_issue_id and item_id = v_item_id;

      if not found then
        raise exception 'Item % gak ada di goods_issue %, gak bisa diretur', v_item_id, v_goods_issue_id;
      end if;

      v_unit_cost := v_total_cost / v_qty_issued;
      v_line_cost := v_qty_returned * v_unit_cost;
      v_total_cost_returned := v_total_cost_returned + v_line_cost;

      select costing_method into v_costing_method from items where id = v_item_id;

      if v_costing_method = 'FIFO' then
        insert into inventory_lots (item_id, source_type, source_ref, qty_in, unit_cost, lot_date)
        values (v_item_id, 'SALES_RETURN', v_credit_note_id, v_qty_returned, v_unit_cost, p_credit_note_date);
      else
        select qty_on_hand, avg_cost into v_qty_before, v_avg_before
          from inventory_balances where item_id = v_item_id;

        update inventory_balances
          set qty_on_hand = v_qty_before + v_qty_returned,
              avg_cost = (v_qty_before * v_avg_before + v_qty_returned * v_unit_cost) / (v_qty_before + v_qty_returned),
              updated_at = now()
          where item_id = v_item_id;
      end if;

      v_line_items := array_append(v_line_items, v_item_id);
      v_line_qtys := array_append(v_line_qtys, v_qty_returned);
      v_line_costs := array_append(v_line_costs, v_line_cost);
    end loop;

    v_hpp_entry_id := create_journal_entry(
      p_credit_note_date, 'Reversal HPP retur', p_source_ref,
      jsonb_build_array(
        jsonb_build_object('account_id', p_finished_good_account_id, 'debit', v_total_cost_returned, 'credit', 0),
        jsonb_build_object('account_id', p_hpp_account_id, 'debit', 0, 'credit', v_total_cost_returned)
      )
    );

    insert into inventory_returns (credit_note_id, goods_issue_id, journal_entry_id, return_date, source_ref, created_by)
    values (v_credit_note_id, v_goods_issue_id, v_hpp_entry_id, p_credit_note_date, p_source_ref, auth.uid())
    returning id into v_return_id;

    for i in 1..array_length(v_line_items, 1) loop
      insert into inventory_return_lines (inventory_return_id, item_id, qty_returned, total_cost)
      values (v_return_id, v_line_items[i], v_line_qtys[i], v_line_costs[i]);
    end loop;
  end if;

  return v_credit_note_id;
end;
$$;

-- ============================================================
-- RPC: apply_ar_return_credit — pakai saldo kredit retur motong invoice lain
-- (Debit Saldo Kredit Retur Customer / Kredit Piutang Usaha).
-- ============================================================

create function apply_ar_return_credit(
  p_credit_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_return_credit_liability_account_id uuid,
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
    p_entry_date, 'Penerapan saldo kredit retur ke invoice', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_return_credit_liability_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_return_credit_applications (credit_id, invoice_id, amount, source_ref, journal_entry_id, created_by)
  values (p_credit_id, p_invoice_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_application_id;

  return v_application_id;
end;
$$;

-- ============================================================
-- RPC: refund_ar_return_credit — refund tunai saldo kredit retur
-- (Debit Saldo Kredit Retur Customer / Kredit Kas/Bank).
-- ============================================================

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

-- ============================================================
-- RLS Policy
-- ============================================================

alter table ar_return_credits enable row level security;

create policy ar_return_credits_select on ar_return_credits
  for select using (auth.role() = 'authenticated');

create policy ar_return_credits_insert on ar_return_credits
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_return_credit_applications enable row level security;

create policy ar_return_credit_applications_select on ar_return_credit_applications
  for select using (auth.role() = 'authenticated');

create policy ar_return_credit_applications_insert on ar_return_credit_applications
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
-- sengaja gak ada policy UPDATE/DELETE di 3 tabel ini -> RLS default deny + block_edit_delete

-- ============================================================
-- Grant
-- ============================================================

grant select, insert on ar_return_credits to authenticated;
grant select, insert on ar_return_credit_applications to authenticated;
grant select, insert on ar_return_credit_refunds to authenticated;
