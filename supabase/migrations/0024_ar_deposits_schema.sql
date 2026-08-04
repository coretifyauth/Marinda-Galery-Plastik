-- Fase 3 (AR) lanjutan — Uang Muka / DP (menutup memory/scope-debt/ar-uang-muka-dp.md).
-- Ref bisnis: docs/domain/accounts-receivable.md bagian "Uang Muka / DP".
-- Ref ERD+DDL humanable: docs/architecture/ar-schema.md.
-- Reuse: create_journal_entry() (0004), reverse_journal_entry() (0004), block_edit_delete() (0004).
-- Akun COA baru (Uang Muka Penjualan, Pendapatan Lain-lain) di-insert di migration seed
-- (0025), bukan di sini — pola sama '4900 Retur & Potongan Penjualan' (0023).

-- ============================================================
-- Tabel: ar_deposits (DP diterima, selalu dibuat pas terima uang muka)
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

-- ============================================================
-- Tabel: ar_deposit_applications (DP diterapkan ke invoice)
-- ============================================================

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

-- Guard gabungan (before insert):
-- 1. Deposit belum pernah dihanguskan.
-- 2. Gak over-apply terhadap sisa deposit (exclude application yang udah di-reverse
--    lewat cancel_ar_invoice).
-- 3. Deposit & invoice harus customer yang sama — cegah salah pencet nyampur saldo
--    antar-customer.
-- 4. Invoice targetnya belum dibatalkan (gak punya reversal) — pola exclude yang sama
--    kayak dipakai create_ar_invoice punya buat outstanding calc (0020).
-- 5. Gak over-apply terhadap nilai invoice, DIGABUNG sama ar_payment_allocations yang
--    udah ada (bukan dicek sendiri-sendiri) — soalnya sekarang ada 2 jalur independen
--    yang sama-sama ngurangin piutang invoice yang sama, keduanya harus keitung bareng
--    biar gak bisa over-collect (lihat juga ar_payment_allocations_no_over_allocation
--    yang diperluas simetris di bawah).
create function ar_deposit_applications_guard() returns trigger as $$
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

  if v_already_allocated_to_invoice + v_already_applied_to_invoice + new.amount > v_invoice_amount then
    raise exception 'Penerapan deposit ke invoice % melebihi sisa piutang (invoice %, sudah tertutup %, coba terapkan %)',
      new.invoice_id, v_invoice_amount, v_already_allocated_to_invoice + v_already_applied_to_invoice, new.amount;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_deposit_applications_guard_trigger
  before insert on ar_deposit_applications
  for each row execute function ar_deposit_applications_guard();

-- ============================================================
-- Tabel: ar_deposit_forfeitures (DP hangus, order dibatalin sebelum invoice ada)
-- ============================================================

create table ar_deposit_forfeitures (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references ar_deposits(id),
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

-- Guard (before insert): deposit belum pernah dihanguskan, dan gak lagi punya
-- application aktif (yang belum di-reverse) — satu deposit cuma boleh 1 disposisi aktif.
create function ar_deposit_forfeitures_guard() returns trigger as $$
declare
  v_forfeited_count int;
  v_active_applied_count int;
begin
  select count(*) into v_forfeited_count
    from ar_deposit_forfeitures where deposit_id = new.deposit_id;

  if v_forfeited_count > 0 then
    raise exception 'Deposit % udah pernah dihanguskan', new.deposit_id;
  end if;

  select count(*) into v_active_applied_count
    from ar_deposit_applications ada
    where ada.deposit_id = new.deposit_id
      and not exists (
        select 1 from journal_entries je where je.reverses_entry_id = ada.journal_entry_id
      );

  if v_active_applied_count > 0 then
    raise exception 'Deposit % masih diterapkan ke invoice aktif — gak bisa dihanguskan', new.deposit_id;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_deposit_forfeitures_guard_trigger
  before insert on ar_deposit_forfeitures
  for each row execute function ar_deposit_forfeitures_guard();

-- ============================================================
-- RPC: create_ar_deposit — terima DP (Debit Kas / Kredit Uang Muka Penjualan)
-- ============================================================

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

-- ============================================================
-- RPC: apply_ar_deposit — terapkan DP ke invoice (Debit Uang Muka / Kredit Piutang Usaha)
-- ============================================================

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

-- ============================================================
-- RPC: forfeit_ar_deposit — hanguskan DP (Debit Uang Muka / Kredit Pendapatan Lain-lain)
-- ============================================================

create function forfeit_ar_deposit(
  p_deposit_id uuid,
  p_forfeiture_date date,
  p_source_ref text,
  p_deposit_liability_account_id uuid,
  p_other_revenue_account_id uuid
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_amount numeric;
  v_entry_id uuid;
  v_forfeiture_id uuid;
begin
  select amount into v_amount from ar_deposits where id = p_deposit_id;

  v_entry_id := create_journal_entry(
    p_forfeiture_date, 'Uang muka hangus', p_source_ref,
    jsonb_build_array(
      jsonb_build_object('account_id', p_deposit_liability_account_id, 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', p_other_revenue_account_id, 'debit', 0, 'credit', v_amount)
    )
  );

  insert into ar_deposit_forfeitures (deposit_id, forfeiture_date, source_ref, journal_entry_id, created_by)
  values (p_deposit_id, p_forfeiture_date, p_source_ref, v_entry_id, auth.uid())
  returning id into v_forfeiture_id;

  return v_forfeiture_id;
end;
$$;

-- ============================================================
-- ar_payment_allocations_no_over_allocation (0007) — diperluas: ikut hitung
-- ar_deposit_applications di sisi invoice, biar payment sama deposit gak bisa
-- over-collect gabungan (2 jalur independen ke piutang yang sama, harus keitung bareng).
-- ============================================================
create or replace function ar_payment_allocations_no_over_allocation() returns trigger as $$
declare
  v_invoice_amount numeric;
  v_invoice_allocated numeric;
  v_invoice_deposited numeric;
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

  if v_invoice_allocated + v_invoice_deposited + new.amount > v_invoice_amount then
    raise exception 'Alokasi ke invoice % melebihi sisa piutang (sisa %, coba alokasi %)',
      new.invoice_id, v_invoice_amount - v_invoice_allocated - v_invoice_deposited, new.amount;
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
-- create_ar_invoice (0020) — diperluas: outstanding buat cek credit hold ikut
-- ngurangin ar_deposit_applications aktif, bukan cuma ar_payment_allocations. Tanpa ini,
-- customer yang udah nitip DP tetep keitung "outstanding penuh" dan bisa kena credit hold
-- yang gak seharusnya (overly conservative, bukan celah duit — tapi tetap salah).
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
  -- ini. "paid" gabungin ar_payment_allocations + ar_deposit_applications aktif (belum
  -- di-reverse) per invoice.
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
-- cancel_ar_invoice — diperluas: ikut reverse jurnal ar_deposit_applications
-- ============================================================
-- Sebelum ini, cancel_ar_invoice cuma reverse jurnal invoice-nya sendiri. Kalau invoice
-- itu udah punya DP-application, Piutang Usaha bakal nyasar minus (jurnal application
-- gak ikut ke-reverse) dan DP-nya nyangkut gak jelas statusnya. Sekarang RPC ini juga
-- me-reverse tiap jurnal application (yang belum pernah di-reverse) buat invoice itu —
-- DP-nya otomatis balik status "belum dipakai", siap diterapkan ulang/dihanguskan.
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

  return v_new_entry_id;
end;
$$;

-- ============================================================
-- RLS Policy
-- ============================================================

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
-- sengaja gak ada policy UPDATE/DELETE di 3 tabel ini -> RLS default deny + block_edit_delete

-- ============================================================
-- Grant
-- ============================================================

grant select, insert on ar_deposits to authenticated;
grant select, insert on ar_deposit_applications to authenticated;
grant select, insert on ar_deposit_forfeitures to authenticated;
