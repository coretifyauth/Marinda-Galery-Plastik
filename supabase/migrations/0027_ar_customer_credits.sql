-- Fase 3 (AR) lanjutan — Kelebihan Bayar jadi Saldo Kredit Customer
-- (menutup memory/scope-debt/ar-overpayment-saldo-kredit.md).
-- Ref bisnis: docs/domain/accounts-receivable.md bagian "Kelebihan Bayar (Overpayment)
-- jadi Saldo Kredit Customer".
-- Ref ERD+DDL humanable: docs/architecture/ar-schema.md.
-- Reuse: create_journal_entry() (0004), block_edit_delete() (0004).
-- Akun COA baru (Saldo Kredit Customer, kode 2400) di-insert di migration seed (0028),
-- pola sama '2300 Uang Muka Penjualan' (0025).

-- ============================================================
-- Tabel: ar_customer_credits (saldo kredit lahir, selalu dari excess record_ar_payment)
-- ============================================================

create table ar_customer_credits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  payment_id uuid not null references ar_payments(id),
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_customer_credits_customer_id_idx on ar_customer_credits(customer_id);
create index ar_customer_credits_payment_id_idx on ar_customer_credits(payment_id);
create index ar_customer_credits_journal_entry_id_idx on ar_customer_credits(journal_entry_id);

create trigger ar_customer_credits_block_edit_delete
  before update or delete on ar_customer_credits
  for each row execute function block_edit_delete();

-- ============================================================
-- Tabel: ar_customer_credit_applications (saldo kredit dipakai motong invoice lain)
-- ============================================================

create table ar_customer_credit_applications (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ar_customer_credits(id),
  invoice_id uuid not null references ar_invoices(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_customer_credit_applications_credit_id_idx on ar_customer_credit_applications(credit_id);
create index ar_customer_credit_applications_invoice_id_idx on ar_customer_credit_applications(invoice_id);

create trigger ar_customer_credit_applications_block_edit_delete
  before update or delete on ar_customer_credit_applications
  for each row execute function block_edit_delete();

-- ============================================================
-- Tabel: ar_customer_credit_refunds (saldo kredit direfund tunai)
-- ============================================================

create table ar_customer_credit_refunds (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references ar_customer_credits(id),
  amount numeric(14,2) not null check (amount > 0),
  source_ref text not null,
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index ar_customer_credit_refunds_credit_id_idx on ar_customer_credit_refunds(credit_id);

create trigger ar_customer_credit_refunds_block_edit_delete
  before update or delete on ar_customer_credit_refunds
  for each row execute function block_edit_delete();

-- ============================================================
-- Guard: no over-use saldo kredit (before insert applications & refunds).
-- SUM(applications belum di-reverse) + SUM(refunds) per credit gak boleh ngelebihin
-- amount kredit awal — pola exclude-reversed sama ar_deposit_applications (application
-- bisa di-reverse lewat cancel_ar_invoice, lihat perluasan cancel_ar_invoice di bawah).
-- Trigger ar_customer_credit_applications_guard didefinisikan belakangan (digabung 1
-- fungsi, bukan 2 tahap) karena butuh cek gabungan 3 jalur alokasi — lihat di bawah.
-- ============================================================

create function ar_customer_credit_remaining(p_credit_id uuid) returns numeric as $$
  select c.amount
    - coalesce((
        select sum(aca.amount) from ar_customer_credit_applications aca
        where aca.credit_id = p_credit_id
          and not exists (
            select 1 from journal_entries je where je.reverses_entry_id = aca.journal_entry_id
          )
      ), 0)
    - coalesce((select sum(amount) from ar_customer_credit_refunds where credit_id = p_credit_id), 0)
  from ar_customer_credits c
  where c.id = p_credit_id;
$$ language sql stable;

create function ar_customer_credit_refunds_guard() returns trigger as $$
declare
  v_remaining numeric;
begin
  select ar_customer_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Refund saldo kredit % melebihi sisa saldo (sisa %, coba refund %)',
      new.credit_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_customer_credit_refunds_guard_trigger
  before insert on ar_customer_credit_refunds
  for each row execute function ar_customer_credit_refunds_guard();

-- ============================================================
-- record_ar_payment (0007) — diperluas: kalau p_amount melebihi total p_allocations,
-- excess-nya masuk baris jurnal ke-3 (Kredit Saldo Kredit Customer) DALAM journal entry
-- yang sama (1 bukti transfer = 1 entry, bukan 2 payment terpisah), dan insert 1 baris
-- ar_customer_credits. Sebelum ini, Kredit Piutang Usaha selalu = p_amount penuh walau
-- alokasinya kurang dari itu — over-credit Piutang Usaha buat kasus overpayment.
-- p_customer_credit_account_id nullable, cuma wajib diisi kalau beneran ada excess.
-- ============================================================

-- Nambah parameter baru bikin signature beda dari versi 0007 (7 param, gak ada default) —
-- `create or replace` gak nge-replace overload lama karena identitas fungsi di Postgres
-- itu nama+tipe parameter, bukan nama doang. Drop eksplisit versi lama dulu, biar gak
-- ada 2 overload nyangkut & bikin call ambigu (`record_ar_payment(...)` dengan 7 arg bisa
-- match ke overload lama ATAU overload baru yang param ke-8-nya default).
drop function if exists record_ar_payment(uuid, date, numeric, text, uuid, uuid, jsonb);

create or replace function record_ar_payment(
  p_customer_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_source_ref text,
  p_cash_account_id uuid,
  p_receivable_account_id uuid,
  p_allocations jsonb, -- array of {"invoice_id": uuid, "amount": numeric}
  p_customer_credit_account_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_allocated_total numeric := 0;
  v_excess numeric;
  v_lines jsonb;
  v_entry_id uuid;
  v_payment_id uuid;
  v_alloc jsonb;
begin
  select coalesce(sum((a->>'amount')::numeric), 0) into v_allocated_total
    from jsonb_array_elements(p_allocations) a;

  if v_allocated_total > p_amount then
    raise exception 'Total alokasi % melebihi nominal payment %', v_allocated_total, p_amount;
  end if;

  v_excess := p_amount - v_allocated_total;

  if v_excess > 0 and p_customer_credit_account_id is null then
    raise exception 'Payment % melebihi total alokasi % (excess %) — wajib isi p_customer_credit_account_id',
      p_amount, v_allocated_total, v_excess;
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', p_cash_account_id, 'debit', p_amount, 'credit', 0),
    jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', v_allocated_total)
  );

  if v_excess > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', p_customer_credit_account_id, 'debit', 0, 'credit', v_excess)
    );
  end if;

  v_entry_id := create_journal_entry(
    p_payment_date, 'Pelunasan piutang', p_source_ref, v_lines
  );

  insert into ar_payments (customer_id, payment_date, amount, source_ref, journal_entry_id, created_by)
  values (p_customer_id, p_payment_date, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_payment_id;

  for v_alloc in select * from jsonb_array_elements(p_allocations)
  loop
    insert into ar_payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, (v_alloc->>'invoice_id')::uuid, (v_alloc->>'amount')::numeric);
  end loop;

  if v_excess > 0 then
    insert into ar_customer_credits (customer_id, payment_id, amount, journal_entry_id, created_by)
    values (p_customer_id, v_payment_id, v_excess, v_entry_id, auth.uid());
  end if;

  return v_payment_id;
end;
$$;

-- ============================================================
-- RPC: apply_ar_customer_credit — pakai saldo kredit motong invoice lain
-- (Debit Saldo Kredit Customer / Kredit Piutang Usaha)
-- ============================================================

create function apply_ar_customer_credit(
  p_credit_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_customer_credit_account_id uuid,
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
    p_entry_date, 'Penerapan saldo kredit ke invoice', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_customer_credit_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_receivable_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_customer_credit_applications (credit_id, invoice_id, amount, source_ref, journal_entry_id, created_by)
  values (p_credit_id, p_invoice_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_application_id;

  return v_application_id;
end;
$$;

-- ============================================================
-- RPC: refund_ar_customer_credit — refund tunai saldo kredit
-- (Debit Saldo Kredit Customer / Kredit Kas/Bank)
-- ============================================================

create function refund_ar_customer_credit(
  p_credit_id uuid,
  p_amount numeric,
  p_entry_date date,
  p_source_ref text,
  p_customer_credit_account_id uuid,
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
    p_entry_date, 'Refund saldo kredit customer', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_customer_credit_account_id, 'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_cash_account_id, 'debit', 0, 'credit', p_amount)
    )
  );

  insert into ar_customer_credit_refunds (credit_id, amount, source_ref, journal_entry_id, created_by)
  values (p_credit_id, p_amount, p_source_ref, v_entry_id, auth.uid())
  returning id into v_refund_id;

  return v_refund_id;
end;
$$;

-- ============================================================
-- ar_payment_allocations_no_over_allocation (0007, diperluas 0024) — invoice yang
-- outstanding-nya udah dimotong ar_customer_credit_applications juga harus keitung,
-- pola sama perluasan buat ar_deposit_applications (2 jalur independen ke piutang yang
-- sama, harus keitung bareng biar gak over-collect gabungan).
-- ============================================================
create or replace function ar_payment_allocations_no_over_allocation() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_invoice_allocated numeric;
  v_invoice_deposited numeric;
  v_invoice_credited numeric;
  v_payment_amount numeric;
  v_payment_allocated numeric;
begin
  select amount into v_invoice_amount from ar_invoices where id = new.invoice_id;
  select coalesce(sum(amount), 0) into v_invoice_allocated
    from ar_payment_allocations where invoice_id = new.invoice_id;
  select coalesce(sum(ada.amount), 0) into v_invoice_deposited
    from ar_deposit_applications ada
    where ada.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      );
  select coalesce(sum(aca.amount), 0) into v_invoice_credited
    from ar_customer_credit_applications aca
    where aca.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = aca.journal_entry_id
      );

  if v_invoice_allocated + v_invoice_deposited + v_invoice_credited + new.amount > v_invoice_amount then
    raise exception 'Alokasi ke invoice % melebihi sisa piutang (sisa %, coba alokasi %)',
      new.invoice_id, v_invoice_amount - v_invoice_allocated - v_invoice_deposited - v_invoice_credited, new.amount;
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
-- apply_ar_deposit (0024) — guard-nya (ar_deposit_applications_guard) juga perlu
-- ikut hitung ar_customer_credit_applications di sisi invoice, simetris sama perluasan
-- ar_payment_allocations_no_over_allocation di atas.
-- ============================================================
create or replace function ar_deposit_applications_guard() returns trigger as $$
declare
  v_forfeited_count int;
  v_deposit_amount numeric;
  v_deposit_customer_id uuid;
  v_already_applied numeric;
  v_invoice_amount numeric;
  v_invoice_customer_id uuid;
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_already_allocated_to_invoice numeric;
  v_already_applied_to_invoice numeric;
  v_already_credited_to_invoice numeric;
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

  select amount, customer_id, journal_entry_id
    into v_invoice_amount, v_invoice_customer_id, v_invoice_journal_entry_id
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

  select coalesce(sum(amount), 0) into v_already_allocated_to_invoice
    from ar_payment_allocations where invoice_id = new.invoice_id;
  select coalesce(sum(ada.amount), 0) into v_already_applied_to_invoice
    from ar_deposit_applications ada
    where ada.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      );
  select coalesce(sum(aca.amount), 0) into v_already_credited_to_invoice
    from ar_customer_credit_applications aca
    where aca.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = aca.journal_entry_id
      );

  if v_already_allocated_to_invoice + v_already_applied_to_invoice + v_already_credited_to_invoice + new.amount > v_invoice_amount then
    raise exception 'Penerapan deposit ke invoice % melebihi sisa piutang (invoice %, sudah tertutup %, coba terapkan %)',
      new.invoice_id, v_invoice_amount, v_already_allocated_to_invoice + v_already_applied_to_invoice + v_already_credited_to_invoice, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- ar_customer_credit_applications_guard — definisi final (1 fungsi, bukan 2 tahap).
-- Ikut cek invoice belum dibatalkan (pola ar_deposit_applications_guard, sebelumnya
-- kelewat di draft awal — ketauan pas schema-reviewer), dan gabung hitung
-- ar_payment_allocations + ar_deposit_applications (exclude reversed) + sesama
-- ar_customer_credit_applications (exclude reversed) di sisi invoice, supaya 3 jalur
-- independen ke piutang yang sama gak bisa over-collect gabungan.
-- ============================================================
create function ar_customer_credit_applications_guard() returns trigger as $$
declare
  v_remaining numeric;
  v_credit_customer_id uuid;
  v_invoice_amount numeric;
  v_invoice_customer_id uuid;
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_already_allocated numeric;
  v_already_deposited numeric;
  v_already_credited numeric;
begin
  select ar_customer_credit_remaining(new.credit_id) into v_remaining;

  if new.amount > v_remaining then
    raise exception 'Pemakaian saldo kredit % melebihi sisa saldo (sisa %, coba pakai %)',
      new.credit_id, v_remaining, new.amount;
  end if;

  select customer_id into v_credit_customer_id from ar_customer_credits where id = new.credit_id;
  select amount, customer_id, journal_entry_id
    into v_invoice_amount, v_invoice_customer_id, v_invoice_journal_entry_id
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

  select coalesce(sum(amount), 0) into v_already_allocated
    from ar_payment_allocations where invoice_id = new.invoice_id;
  select coalesce(sum(ada.amount), 0) into v_already_deposited
    from ar_deposit_applications ada
    where ada.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      );
  select coalesce(sum(aca.amount), 0) into v_already_credited
    from ar_customer_credit_applications aca
    where aca.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = aca.journal_entry_id
      );

  if v_already_allocated + v_already_deposited + v_already_credited + new.amount > v_invoice_amount then
    raise exception 'Penerapan saldo kredit ke invoice % melebihi sisa piutang (invoice %, sudah tertutup %, coba terapkan %)',
      new.invoice_id, v_invoice_amount, v_already_allocated + v_already_deposited + v_already_credited, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_customer_credit_applications_guard_trigger
  before insert on ar_customer_credit_applications
  for each row execute function ar_customer_credit_applications_guard();

-- ============================================================
-- cancel_ar_invoice (0009, diperluas 0024) — diperluas lagi: ikut reverse jurnal
-- ar_customer_credit_applications juga, simetris sama perluasan buat
-- ar_deposit_applications di 0024. Tanpa ini, invoice yang udah dimotong saldo kredit
-- terus dibatalkan bikin Piutang Usaha nyasar minus (jurnal application-nya gak ikut
-- ke-reverse) dan saldo kreditnya kepakai permanen tanpa invoice yang beneran nutup —
-- ketauan pas schema-reviewer, kelas bug sama persis yang komentar 0024 udah jelasin
-- buat DP.
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
  v_original_entry_id uuid;
  v_new_entry_id uuid;
  v_application record;
  v_credit_application record;
begin
  select count(*) into v_allocated_count
  from ar_payment_allocations where invoice_id = p_invoice_id;

  if v_allocated_count > 0 then
    raise exception 'Invoice % udah punya % alokasi payment — gak bisa dibatalkan lewat jalur ini', p_invoice_id, v_allocated_count;
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

  return v_new_entry_id;
end;
$$;

-- ============================================================
-- create_ar_invoice (0007, di-extend 0020 buat credit hold, 0024 buat DP) — diperluas
-- lagi: outstanding buat cek credit hold sekarang ikut ngurangin
-- ar_customer_credit_applications aktif juga, gak cuma ar_payment_allocations +
-- ar_deposit_applications. Tanpa ini, invoice yang piutangnya udah sebagian dipotong
-- saldo kredit tetep keitung "outstanding penuh" dan bisa salah kena credit hold —
-- kelas bug sama persis yang 0024 udah jelasin buat DP, ketauan lewat schema-reviewer.
-- Overly conservative doang (bukan celah duit), tapi tetap salah.
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

  -- Outstanding = sisa amount invoice open (belum lunas, belum dibatalkan) milik customer
  -- ini. "paid" gabungin ar_payment_allocations + ar_deposit_applications +
  -- ar_customer_credit_applications aktif (belum di-reverse) per invoice.
  select coalesce(sum(ai.amount - coalesce(alloc.paid, 0)), 0),
         coalesce(max(p_invoice_date - ai.due_date), 0)
    into v_outstanding, v_max_overdue_days
    from ar_invoices ai
    left join (
      select combined.invoice_id, sum(combined.amount) as paid
      from (
        select invoice_id, amount from ar_payment_allocations
        union all
        select ada.invoice_id, ada.amount
          from ar_deposit_applications ada
          where not exists (
            select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
          )
        union all
        select aca.invoice_id, aca.amount
          from ar_customer_credit_applications aca
          where not exists (
            select 1 from journal_entries je where je.reverses_entry_id = aca.journal_entry_id
          )
      ) combined
      group by combined.invoice_id
    ) alloc on alloc.invoice_id = ai.id
    where ai.customer_id = p_customer_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ai.journal_entry_id
      )
      and ai.amount - coalesce(alloc.paid, 0) > 0;

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
-- RLS Policy
-- ============================================================

alter table ar_customer_credits enable row level security;

create policy ar_customer_credits_select on ar_customer_credits
  for select using (auth.role() = 'authenticated');

create policy ar_customer_credits_insert on ar_customer_credits
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_customer_credit_applications enable row level security;

create policy ar_customer_credit_applications_select on ar_customer_credit_applications
  for select using (auth.role() = 'authenticated');

create policy ar_customer_credit_applications_insert on ar_customer_credit_applications
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table ar_customer_credit_refunds enable row level security;

create policy ar_customer_credit_refunds_select on ar_customer_credit_refunds
  for select using (auth.role() = 'authenticated');

create policy ar_customer_credit_refunds_insert on ar_customer_credit_refunds
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE di 3 tabel ini -> RLS default deny + block_edit_delete

-- ============================================================
-- Grant
-- ============================================================

grant select, insert on ar_customer_credits to authenticated;
grant select, insert on ar_customer_credit_applications to authenticated;
grant select, insert on ar_customer_credit_refunds to authenticated;
