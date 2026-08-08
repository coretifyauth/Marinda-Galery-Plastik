-- AR Deposit: tambah disposisi ketiga (refund tunai) + jadiin ketiga disposisi partial-capable.
-- Desain awal (0024 pra-squash): "1 deposit cuma boleh 1 disposisi aktif" (diterapkan ATAU
-- hangus, gak dua-duanya), forfeit_ar_deposit selalu ambil ar_deposits.amount PENUH sekali
-- jalan (gak nerima parameter nominal). Keputusan bisnis (2026-08-09): di dunia nyata,
-- penyelesaian 1 DP jarang "sekali putus" -- bisa aja sebagian diterapkan ke invoice, sebagian
-- direfund (itikad baik), sisanya baru hangus. Sekarang ketiganya (applications/refunds/
-- forfeitures) partial-capable, dijaga 1 fungsi terpusat ar_deposit_remaining().
-- Ref: docs/domain/accounts-receivable.md bagian "Kenapa Deposit Sekarang Partial-Capable".

-- forfeit_ar_deposit: signature lama gak punya p_amount (selalu ambil amount penuh) --
-- signature baru nerima p_amount eksplisit, jadi perlu drop dulu (tipe param beda jumlah).
drop function if exists forfeit_ar_deposit(uuid, date, text, uuid, uuid);

-- ar_deposit_forfeitures butuh kolom amount baru -- sebelumnya nominal selalu diambil dari
-- ar_deposits.amount langsung (gak disimpan per baris karena selalu penuh & cuma 1 baris).
-- Gak butuh default -- tabel ini 0 baris di live DB (diverifikasi via supabase db query
-- --linked sebelum nulis migration ini), jadi not null aman ditambah langsung.
alter table ar_deposit_forfeitures add column amount numeric(14,2) not null check (amount > 0);

-- ar_deposit_refunds: disposisi baru, mirror ar_deposit_forfeitures tapi lawan jurnalnya Kas
-- (bukan Pendapatan Lain-lain) -- refund gak punya dampak Laba Rugi.
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

-- ar_deposit_remaining: sumber kebenaran tunggal sisa DP, mirror pola ar_invoice_remaining().
-- Forfeitures & refunds gak pernah punya jalur reversal (beda dari applications yang bisa
-- di-unwind cancel_ar_invoice), jadi SUM langsung tanpa exclude-reversed buat 2 reducer itu.
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

alter table ar_deposit_refunds enable row level security;

create policy ar_deposit_refunds_select on ar_deposit_refunds
  for select using (auth.role() = 'authenticated');

create policy ar_deposit_refunds_insert on ar_deposit_refunds
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on ar_deposit_refunds to authenticated;

-- ar_deposit_applications_guard: cabut blok "belum pernah dihanguskan" (forfeiture gak lagi
-- eksklusif sama application) -- gantiin dengan cek ar_deposit_remaining() yang udah nyakup
-- applications+refunds+forfeitures sekaligus.
create or replace function ar_deposit_applications_guard() returns trigger as $$
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

-- ar_deposit_forfeitures_guard: sama pola, ganti 2 cek boolean lama ("belum pernah hangus" +
-- "gak ada application aktif") jadi 1 cek numerik lewat ar_deposit_remaining().
create or replace function ar_deposit_forfeitures_guard() returns trigger as $$
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

-- forfeit_ar_deposit: signature baru nerima p_amount (boleh sebagian dari ar_deposits.amount,
-- gak wajib penuh lagi).
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
