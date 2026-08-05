-- Fase 3 (AR) lanjutan — Piutang Tak Tertagih (Bad Debt Write-off), direct write-off method
-- (menutup memory/scope-debt/ar-piutang-tak-tertagih.md).
-- Ref bisnis: docs/domain/accounts-receivable.md bagian "Piutang Tak Tertagih (Bad Debt
-- Write-off)".
-- Ref ERD+DDL humanable: docs/architecture/ar-schema.md.
-- Reuse: create_journal_entry() (0004), block_edit_delete() (0004).
-- Akun COA baru (Beban Piutang Tak Tertagih, kode 5700) di-insert di migration seed (0030),
-- pola sama '2300 Uang Muka Penjualan' (0025)/'2400 Saldo Kredit Customer' (0028).

-- ============================================================
-- Tabel: ar_bad_debt_writeoffs (write-off, selalu terhadap 1 invoice)
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
-- Guard: ar_bad_debt_writeoffs_no_over_writeoff (before insert).
-- Beda dari ar_credit_notes_no_over_return (yang sengaja independen, boleh bikin
-- outstanding negatif) — write-off gak boleh ngelebihin SISA OUTSTANDING RIIL invoice
-- (amount dikurangi SEMUA reducer lain yang udah ada: payment allocation, retur, DP
-- application aktif, customer credit application aktif, write-off lain yang udah ada) —
-- gak masuk akal "menghapus" uang yang udah lunas/diretur/dikreditkan duluan lewat jalur
-- lain. Juga nolak kalau invoice-nya udah dibatalkan, pola sama
-- ar_deposit_applications_guard/ar_customer_credit_applications_guard.
-- ============================================================

create function ar_bad_debt_writeoffs_no_over_writeoff() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_invoice_journal_entry_id uuid;
  v_invoice_cancelled boolean;
  v_allocated numeric;
  v_returned numeric;
  v_deposited numeric;
  v_credited numeric;
  v_written_off numeric;
  v_remaining numeric;
begin
  select amount, journal_entry_id into v_invoice_amount, v_invoice_journal_entry_id
    from ar_invoices where id = new.invoice_id;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_invoice_journal_entry_id
  ) into v_invoice_cancelled;

  if v_invoice_cancelled then
    raise exception 'Invoice % udah dibatalkan — gak bisa di-write-off', new.invoice_id;
  end if;

  select coalesce(sum(amount), 0) into v_allocated
    from ar_payment_allocations where invoice_id = new.invoice_id;

  select coalesce(sum(amount), 0) into v_returned
    from ar_credit_notes where invoice_id = new.invoice_id;

  select coalesce(sum(ada.amount), 0) into v_deposited
    from ar_deposit_applications ada
    where ada.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      );

  select coalesce(sum(aca.amount), 0) into v_credited
    from ar_customer_credit_applications aca
    where aca.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = aca.journal_entry_id
      );

  select coalesce(sum(abw.amount), 0) into v_written_off
    from ar_bad_debt_writeoffs abw
    where abw.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = abw.journal_entry_id
      );

  v_remaining := v_invoice_amount - v_allocated - v_returned - v_deposited - v_credited - v_written_off;

  if new.amount > v_remaining then
    raise exception 'Write-off invoice % melebihi sisa outstanding riil (sisa %, coba write-off %)',
      new.invoice_id, v_remaining, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_bad_debt_writeoffs_no_over_writeoff_trigger
  before insert on ar_bad_debt_writeoffs
  for each row execute function ar_bad_debt_writeoffs_no_over_writeoff();

-- ============================================================
-- RPC: write_off_ar_invoice — direct write-off (Debit Beban Piutang Tak Tertagih /
-- Kredit Piutang Usaha). 1 kejadian = 1 jurnal, gak ada tahap estimasi/cadangan
-- (allowance method sengaja gak dipakai, lihat rationale di docs/domain).
-- Nominal (p_amount) input eksplisit dari caller, konsisten sama pola RPC AR lain
-- (create_ar_invoice/record_ar_payment/create_ar_credit_note) yang gak pernah nebak
-- nominal uang dari data lain.
-- ============================================================

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

-- ============================================================
-- ar_payment_allocations_no_over_allocation (0007, diperluas 0024/0027) — diperluas
-- lagi: invoice yang sebagian outstanding-nya udah di-write-off juga harus keitung,
-- pola sama 3 perluasan sebelumnya (DP, customer credit).
-- ============================================================
create or replace function ar_payment_allocations_no_over_allocation() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_invoice_allocated numeric;
  v_invoice_deposited numeric;
  v_invoice_credited numeric;
  v_invoice_written_off numeric;
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
  select coalesce(sum(abw.amount), 0) into v_invoice_written_off
    from ar_bad_debt_writeoffs abw
    where abw.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = abw.journal_entry_id
      );

  if v_invoice_allocated + v_invoice_deposited + v_invoice_credited + v_invoice_written_off + new.amount > v_invoice_amount then
    raise exception 'Alokasi ke invoice % melebihi sisa piutang (sisa %, coba alokasi %)',
      new.invoice_id,
      v_invoice_amount - v_invoice_allocated - v_invoice_deposited - v_invoice_credited - v_invoice_written_off,
      new.amount;
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
-- ar_deposit_applications_guard (0024, diperluas 0027) — diperluas lagi: ikut hitung
-- ar_bad_debt_writeoffs di sisi invoice, simetris perluasan ar_payment_allocations di atas.
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
  v_already_written_off_to_invoice numeric;
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
  select coalesce(sum(abw.amount), 0) into v_already_written_off_to_invoice
    from ar_bad_debt_writeoffs abw
    where abw.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = abw.journal_entry_id
      );

  if v_already_allocated_to_invoice + v_already_applied_to_invoice + v_already_credited_to_invoice + v_already_written_off_to_invoice + new.amount > v_invoice_amount then
    raise exception 'Penerapan deposit ke invoice % melebihi sisa piutang (invoice %, sudah tertutup %, coba terapkan %)',
      new.invoice_id, v_invoice_amount,
      v_already_allocated_to_invoice + v_already_applied_to_invoice + v_already_credited_to_invoice + v_already_written_off_to_invoice,
      new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- ar_customer_credit_applications_guard (0027) — diperluas: ikut hitung
-- ar_bad_debt_writeoffs di sisi invoice, simetris 2 perluasan di atas.
-- ============================================================
create or replace function ar_customer_credit_applications_guard() returns trigger as $$
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
  v_already_written_off numeric;
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
  select coalesce(sum(abw.amount), 0) into v_already_written_off
    from ar_bad_debt_writeoffs abw
    where abw.invoice_id = new.invoice_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = abw.journal_entry_id
      );

  if v_already_allocated + v_already_deposited + v_already_credited + v_already_written_off + new.amount > v_invoice_amount then
    raise exception 'Penerapan saldo kredit ke invoice % melebihi sisa piutang (invoice %, sudah tertutup %, coba terapkan %)',
      new.invoice_id, v_invoice_amount,
      v_already_allocated + v_already_deposited + v_already_credited + v_already_written_off,
      new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

-- ============================================================
-- cancel_ar_invoice (0009, diperluas 0024/0027) — diperluas lagi: nolak keras kalau
-- invoice udah punya ar_bad_debt_writeoffs. Beda dari ar_deposit_applications/
-- ar_customer_credit_applications (auto-unwind) — write-off itu keputusan bisnis
-- ("piutang ini gak akan tertagih") yang udah dijurnal sebagai kerugian nyata, sama
-- kelasnya kayak ar_payment_allocations (piutang udah "kesentuh" transaksi lain, ditolak
-- keras, bukan di-unwind otomatis).
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

  return v_new_entry_id;
end;
$$;

-- ============================================================
-- create_ar_invoice (0007, di-extend 0020/0024/0027) — diperluas lagi: outstanding buat
-- cek credit hold sekarang ikut ngurangin ar_bad_debt_writeoffs aktif juga. Tanpa ini,
-- piutang yang udah dihapusbukukan tetep keitung "outstanding" dan bisa salah nyumbang
-- ke credit hold customer itu (overly conservative, kelas bug sama persis 3 perluasan
-- sebelumnya).
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
  -- ar_customer_credit_applications + ar_bad_debt_writeoffs aktif (belum di-reverse) per invoice.
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
        union all
        select abw.invoice_id, abw.amount
          from ar_bad_debt_writeoffs abw
          where not exists (
            select 1 from journal_entries je where je.reverses_entry_id = abw.journal_entry_id
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

alter table ar_bad_debt_writeoffs enable row level security;

create policy ar_bad_debt_writeoffs_select on ar_bad_debt_writeoffs
  for select using (auth.role() = 'authenticated');

create policy ar_bad_debt_writeoffs_insert on ar_bad_debt_writeoffs
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );
-- sengaja gak ada policy UPDATE/DELETE -> RLS default deny + block_edit_delete

-- ============================================================
-- Grant
-- ============================================================

grant select, insert on ar_bad_debt_writeoffs to authenticated;
