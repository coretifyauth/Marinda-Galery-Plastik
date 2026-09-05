-- Fase 2 langkah 3 (memory/scope-debt/ar-ap-unify-transactions.md) -- tabel
-- transactions/transaction_lines + RPC create_transaction, gantiin ar_invoices+ap_bills.
-- Jalan PARALEL: ar_invoices/ap_bills lama BELUM disentuh, create_goods_issue/
-- create_goods_receipt BELUM diganti manggil RPC ini (nunggu Fase 3 backfill+repoint FK
-- 11 tabel turunan -- kalau caller diganti sebelum itu, ar_payments/ar_credit_notes dkk
-- bakal gagal FK ke invoice/bill yang sekarang lahir di transactions, bukan ar_invoices/
-- ap_bills lagi -- lihat catatan blast radius di scope-debt).
--
-- Credit Hold (ar_bad_debt_writeoffs + counterparties.credit_limit/overdue_threshold_days
-- + check di create_ar_invoice) SENGAJA gak dibawa ke sini -- keputusan owner 2026-09-05,
-- disingkirkan total pas Fase 3 nanti drop ar_invoices/create_ar_invoice lama.
--
-- outstanding/status/origin masih placeholder murni (diisi sekali pas insert, BUKAN
-- dijaga trigger recompute) -- gak ada reducer (ar_payments-equivalent dkk) yang nunjuk
-- ke transactions sampai Fase 3, jadi trigger recompute belum relevan sekarang.

create table transactions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('INBOUND', 'OUTBOUND')), -- INBOUND=piutang(dulu ar_invoices), OUTBOUND=utang(dulu ap_bills)
  counterparty_id uuid not null references counterparties(id),
  date date not null,
  due_date date not null,
  description text,
  source_ref text not null,
  amount numeric(14,2) not null check (amount > 0),
  outstanding numeric(14,2) not null,
  returned numeric(14,2) not null default 0,
  status text not null default 'belum',
  origin text not null default 'financial_only',
  supplier_document_ref text, -- cuma keisi type='OUTBOUND'
  journal_entry_id uuid not null references journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index transactions_counterparty_id_idx on transactions(counterparty_id);
create index transactions_journal_entry_id_idx on transactions(journal_entry_id);
create index transactions_type_idx on transactions(type);

create table transaction_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  account_id uuid not null references accounts(id),
  amount numeric(14,2) not null check (amount > 0),
  is_tax boolean not null default false
);

create index transaction_lines_transaction_id_idx on transaction_lines(transaction_id);

create trigger transactions_block_edit_delete
  before update or delete on transactions
  for each row execute function block_edit_delete();

-- Guard type-safety counterparty, pola persis 0059 (counterparty_role_guard) --
-- INBOUND (piutang) wajib ke pihak berperan customer, OUTBOUND (utang) wajib supplier.
create trigger transactions_counterparty_role_guard_inbound
  before insert on transactions
  for each row when (new.type = 'INBOUND')
  execute function counterparty_role_guard('counterparty_id', 'customer');

create trigger transactions_counterparty_role_guard_outbound
  before insert on transactions
  for each row when (new.type = 'OUTBOUND')
  execute function counterparty_role_guard('counterparty_id', 'supplier');

create trigger transaction_lines_block_edit_delete
  before update or delete on transaction_lines
  for each row execute function block_edit_delete();

alter table transactions enable row level security;

create policy transactions_select on transactions
  for select using (auth.role() = 'authenticated');

create policy transactions_insert on transactions
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

alter table transaction_lines enable row level security;

create policy transaction_lines_select on transaction_lines
  for select using (auth.role() = 'authenticated');

create policy transaction_lines_insert on transaction_lines
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant'))
  );

grant select, insert on transactions to authenticated;
grant select, insert on transaction_lines to authenticated;

create function create_transaction(
  p_type text,
  p_counterparty_id uuid,
  p_date date,
  p_description text,
  p_source_ref text,
  p_lines jsonb, -- array of {"account_id":uuid,"amount":numeric} -- kategori, BUKAN termasuk PPN
  p_control_account_id uuid, -- INBOUND: Piutang Usaha, OUTBOUND: Utang Usaha
  p_apply_tax boolean default false,
  p_supplier_document_ref text default null -- cuma dipakai type='OUTBOUND'
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_term_days int;
  v_due_date date;
  v_entry_id uuid;
  v_transaction_id uuid;
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
  if p_type not in ('INBOUND', 'OUTBOUND') then
    raise exception 'p_type harus INBOUND atau OUTBOUND, dapat %', p_type;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'p_lines wajib punya minimal 1 baris';
  end if;

  select payment_term_days into v_term_days from counterparties where id = p_counterparty_id;
  v_due_date := p_date + v_term_days;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_amount := (v_line->>'amount')::numeric;
    if v_line_amount <= 0 then
      raise exception 'Setiap baris p_lines harus amount > 0, dapat %', v_line_amount;
    end if;
    v_subtotal := v_subtotal + v_line_amount;
  end loop;

  if p_apply_tax then
    select is_active, ppn_rate,
           case when p_type = 'INBOUND' then ppn_keluaran_account_id else ppn_masukan_account_id end
      into v_tax_active, v_tax_rate, v_tax_account_id
      from tax_settings;

    if not v_tax_active or v_tax_account_id is null then
      raise exception 'PPN belum aktif atau akun PPN belum diset';
    end if;

    v_tax_amount := round(v_subtotal * v_tax_rate / 100, 2);
  end if;

  v_total_amount := v_subtotal + v_tax_amount;

  -- baris FIXED: control account (Piutang debit / Utang kredit)
  if p_type = 'INBOUND' then
    v_journal_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_control_account_id, 'debit', v_total_amount, 'credit', 0)
    );
  else
    v_journal_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_control_account_id, 'debit', 0, 'credit', v_total_amount)
    );
  end if;

  -- baris VARIABEL: kategori dari p_lines, arah kebalik dari baris FIXED
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_amount := (v_line->>'amount')::numeric;
    if p_type = 'INBOUND' then
      v_journal_lines := v_journal_lines || jsonb_build_array(
        jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', 0, 'credit', v_line_amount)
      );
    else
      v_journal_lines := v_journal_lines || jsonb_build_array(
        jsonb_build_object('account_id', (v_line->>'account_id')::uuid, 'debit', v_line_amount, 'credit', 0)
      );
    end if;
  end loop;

  if p_apply_tax then
    if p_type = 'INBOUND' then
      v_journal_lines := v_journal_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_tax_account_id, 'debit', 0, 'credit', v_tax_amount)
      );
    else
      v_journal_lines := v_journal_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_tax_account_id, 'debit', v_tax_amount, 'credit', 0)
      );
    end if;
  end if;

  v_entry_id := create_journal_entry(p_date, p_description, p_source_ref, v_journal_lines);

  insert into transactions (
    type, counterparty_id, date, due_date, description, source_ref, amount,
    outstanding, status, supplier_document_ref, journal_entry_id, created_by
  )
  values (
    p_type, p_counterparty_id, p_date, v_due_date, p_description, p_source_ref, v_total_amount,
    v_total_amount, 'belum',
    case when p_type = 'OUTBOUND' then p_supplier_document_ref else null end,
    v_entry_id, auth.uid()
  )
  returning id into v_transaction_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, false);
  end loop;

  if p_apply_tax then
    insert into transaction_lines (transaction_id, account_id, amount, is_tax)
    values (v_transaction_id, v_tax_account_id, v_tax_amount, true);
  end if;

  return v_transaction_id;
end;
$$;
