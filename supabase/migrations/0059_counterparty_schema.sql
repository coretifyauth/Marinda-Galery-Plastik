-- Fase 1 dari memory/scope-debt/order-generalization.md (keputusan owner, 2026-09-03):
-- gabung customers+suppliers jadi 1 tabel counterparties + counterparty_type_mapping (role).
--
-- Proteksi type-safety yang dipilih: TRIGGER di tabel transaksional (bukan RPC-only security
-- definer) — 11 tabel (ar_invoices/ar_payments/ar_deposits/ar_return_credits/sales_orders/
-- pos_sales sisi customer; ap_bills/ap_payments/ap_return_credits/ap_deposits/purchase_orders
-- sisi supplier) dapat guard trigger yang cek counterparty_type_mapping sebelum insert.
--
-- Strategi migrasi data: counterparties dibackfill PAKAI ID YANG SAMA PERSIS dari customers/
-- suppliers (UUID gak pernah collide antar tabel) -- jadi ke-11 tabel FK di atas GAK PERLU
-- backfill/UPDATE data sama sekali, cukup DROP+ADD CONSTRAINT nunjuk ke tabel baru (DDL murni,
-- bukan row-level UPDATE, gak kena trigger block_edit_delete apa pun -- beda dari migration
-- 0057 yang perlu disable/enable trigger karena beneran nulis ulang data baris).
--
-- customers/suppliers (TABEL LAMA) SENGAJA GAK DI-DROP di migration ini -- /customers dan
-- /suppliers (UI) serta RPC create_ar_invoice/create_ap_bill/delete_customer/delete_supplier
-- diupdate BARENG migration ini biar gak ada window customer/supplier baru "hilang" (dibuat di
-- tabel lama, gak kepakai RPC yang sekarang baca counterparties). Sisa ~26 file frontend lain
-- (nested-select display + dropdown pemilih di form AR/AP/PO/SO/POS) adalah langkah lanjutan
-- terpisah -- data existing tetap jalan normal sampai itu selesai, cuma customer/supplier BARU
-- yang gak akan muncul di form2 itu sampai filenya diupdate. customers/suppliers didrop di
-- migration terpisah nanti begitu semua caller pindah.

-- ============================================================
-- 1. Tabel counterparties + counterparty_type_mapping
-- ============================================================

create table counterparties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  payment_term_days int not null check (payment_term_days > 0),
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit > 0),
  overdue_threshold_days int check (overdue_threshold_days is null or overdue_threshold_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger counterparties_set_updated_at
  before update on counterparties
  for each row execute function set_updated_at();

-- role sekali ditetapkan gak berubah -- gak ada policy update/delete di sini, cuma insert lewat
-- delete_counterparty()/backfill dan select bebas.
create table counterparty_type_mapping (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references counterparties(id),
  role text not null check (role in ('customer', 'supplier')),
  unique (counterparty_id, role)
);

alter table counterparties enable row level security;

create policy counterparties_select on counterparties
  for select using (auth.role() = 'authenticated');

create policy counterparties_insert on counterparties
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin', 'accountant'))
  );

create policy counterparties_update on counterparties
  for update using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin', 'accountant'))
  );

grant select, insert, update on counterparties to authenticated;

alter table counterparty_type_mapping enable row level security;

create policy counterparty_type_mapping_select on counterparty_type_mapping
  for select using (auth.role() = 'authenticated');

create policy counterparty_type_mapping_insert on counterparty_type_mapping
  for insert with check (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name in ('admin', 'accountant'))
  );

grant select, insert on counterparty_type_mapping to authenticated;

-- ============================================================
-- 2. Backfill -- PAKAI ID ASLI dari customers/suppliers, bukan ID baru. Ini yang bikin repoint
--    FK di langkah 3 gak perlu nyentuh data sama sekali.
-- ============================================================

-- Pre-flight safety check (ketauan schema-reviewer) -- backfill di bawah ASUMSI id customers
-- gak pernah collide sama id suppliers (dua-duanya gen_random_uuid(), peluangnya nyaris nol).
-- Kalaupun collide, PK violation di insert kedua bakal bikin migration gagal bersih (rollback
-- total, transaksi tunggal) -- tapi cek eksplisit di sini kasih pesan jelas duluan, bukan
-- error PK mentah yang bikin bingung.
do $$
begin
  if exists (select 1 from customers c join suppliers s on c.id = s.id) then
    raise exception 'ID collision antara customers dan suppliers ditemukan -- migration ini gak aman dijalankan apa adanya, butuh strategi ID baru buat counterparties';
  end if;
end $$;

insert into counterparties (id, name, contact, payment_term_days, credit_limit, overdue_threshold_days, archived_at, created_at, updated_at)
select id, name, contact, payment_term_days, credit_limit, overdue_threshold_days, archived_at, created_at, updated_at
from customers;

insert into counterparties (id, name, contact, payment_term_days, archived_at, created_at, updated_at)
select id, name, contact, payment_term_days, archived_at, created_at, updated_at
from suppliers;

insert into counterparty_type_mapping (counterparty_id, role)
select id, 'customer' from customers;

insert into counterparty_type_mapping (counterparty_id, role)
select id, 'supplier' from suppliers;

-- ============================================================
-- 3. Repoint 11 FK constraint dari customers/suppliers ke counterparties. Pakai fungsi
--    introspeksi (baca pg_constraint langsung), BUKAN nebak nama constraint -- aman dari
--    kemungkinan drift penamaan.
-- ============================================================

create function _repoint_fk_to_counterparties(p_table regclass, p_column name) returns void
language plpgsql
security invoker
as $$
declare
  v_old_conname text;
  v_new_conname text;
begin
  select conname into v_old_conname
    from pg_constraint
    where conrelid = p_table and contype = 'f'
      and conkey = (
        select array_agg(attnum) from pg_attribute
        where attrelid = p_table and attname = p_column
      );

  if v_old_conname is not null then
    execute format('alter table %s drop constraint %I', p_table, v_old_conname);
  end if;

  v_new_conname := p_table::text || '_' || p_column || '_fkey';
  execute format('alter table %s add constraint %I foreign key (%I) references counterparties(id)',
    p_table, v_new_conname, p_column);
end;
$$;

select _repoint_fk_to_counterparties('ar_invoices', 'customer_id');
select _repoint_fk_to_counterparties('ar_payments', 'customer_id');
select _repoint_fk_to_counterparties('ar_deposits', 'customer_id');
select _repoint_fk_to_counterparties('ar_return_credits', 'customer_id');
select _repoint_fk_to_counterparties('sales_orders', 'customer_id');
select _repoint_fk_to_counterparties('pos_sales', 'customer_id');
select _repoint_fk_to_counterparties('ap_bills', 'supplier_id');
select _repoint_fk_to_counterparties('ap_payments', 'supplier_id');
select _repoint_fk_to_counterparties('ap_return_credits', 'supplier_id');
select _repoint_fk_to_counterparties('ap_deposits', 'supplier_id');
select _repoint_fk_to_counterparties('purchase_orders', 'supplier_id');

drop function _repoint_fk_to_counterparties(regclass, name);

-- ============================================================
-- 4. Guard trigger type-safety -- pastikan counterparty yang dipilih beneran berperan sesuai
--    arah transaksi (gak bisa PO nunjuk pihak yang cuma customer, atau sebaliknya). NULL tetap
--    diizinkan lolos (kolom nullable, mis. pos_sales.customer_id -- walk-in kios).
-- ============================================================

create function counterparty_role_guard() returns trigger as $$
declare
  v_column_name text := TG_ARGV[0];
  v_required_role text := TG_ARGV[1];
  v_counterparty_id uuid;
begin
  v_counterparty_id := (to_jsonb(new) ->> v_column_name)::uuid;

  if v_counterparty_id is null then
    return new;
  end if;

  if not exists (
    select 1 from counterparty_type_mapping
    where counterparty_id = v_counterparty_id and role = v_required_role
  ) then
    raise exception 'Pihak % bukan % terdaftar -- gak bisa dipakai di sini', v_counterparty_id, v_required_role;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger ar_invoices_counterparty_role_guard
  before insert on ar_invoices
  for each row execute function counterparty_role_guard('customer_id', 'customer');

create trigger ar_payments_counterparty_role_guard
  before insert on ar_payments
  for each row execute function counterparty_role_guard('customer_id', 'customer');

create trigger ar_deposits_counterparty_role_guard
  before insert on ar_deposits
  for each row execute function counterparty_role_guard('customer_id', 'customer');

create trigger ar_return_credits_counterparty_role_guard
  before insert on ar_return_credits
  for each row execute function counterparty_role_guard('customer_id', 'customer');

create trigger sales_orders_counterparty_role_guard
  before insert on sales_orders
  for each row execute function counterparty_role_guard('customer_id', 'customer');

create trigger pos_sales_counterparty_role_guard
  before insert on pos_sales
  for each row execute function counterparty_role_guard('customer_id', 'customer');

create trigger ap_bills_counterparty_role_guard
  before insert on ap_bills
  for each row execute function counterparty_role_guard('supplier_id', 'supplier');

create trigger ap_payments_counterparty_role_guard
  before insert on ap_payments
  for each row execute function counterparty_role_guard('supplier_id', 'supplier');

create trigger ap_return_credits_counterparty_role_guard
  before insert on ap_return_credits
  for each row execute function counterparty_role_guard('supplier_id', 'supplier');

create trigger ap_deposits_counterparty_role_guard
  before insert on ap_deposits
  for each row execute function counterparty_role_guard('supplier_id', 'supplier');

create trigger purchase_orders_counterparty_role_guard
  before insert on purchase_orders
  for each row execute function counterparty_role_guard('supplier_id', 'supplier');

-- ============================================================
-- 5. create_ar_invoice -- signature/behavior gak berubah sama sekali, cuma sumber lookup
--    payment_term_days/credit_limit/overdue_threshold_days pindah dari customers ke
--    counterparties (create or replace aman, param list identik).
-- ============================================================

create or replace function create_ar_invoice(
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
    from counterparties where id = p_customer_id;
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

-- ============================================================
-- 6. create_ap_bill -- sama pola: cuma sumber lookup payment_term_days pindah dari suppliers
--    ke counterparties.
-- ============================================================

create or replace function create_ap_bill(
  p_supplier_id uuid,
  p_bill_date date,
  p_description text,
  p_source_ref text,
  p_debit_lines jsonb,
  p_payable_account_id uuid,
  p_apply_tax boolean default false,
  p_supplier_document_ref text default null
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

  select payment_term_days into v_term_days from counterparties where id = p_supplier_id;
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

  insert into ap_bills (supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id, created_by, supplier_document_ref)
  values (p_supplier_id, p_bill_date, v_due_date, p_description, p_source_ref, v_total_amount, v_entry_id, auth.uid(), p_supplier_document_ref)
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

-- ============================================================
-- 7. delete_customer/delete_supplier -> gabung jadi delete_counterparty. Pola sama delete_item
--    (hapus counterparty_type_mapping duluan di blok yang sama -- dianggap konfigurasi peran,
--    bukan riwayat transaksi eksternal -- baru counterparties-nya).
-- ============================================================

drop function if exists delete_customer(uuid);
drop function if exists delete_supplier(uuid);

create function delete_counterparty(p_counterparty_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin', 'accountant')
  ) then
    raise exception 'Cuma admin/accountant yang boleh menghapus counterparty';
  end if;

  begin
    delete from counterparty_type_mapping where counterparty_id = p_counterparty_id;
    delete from counterparties where id = p_counterparty_id;
    return 'deleted';
  exception when foreign_key_violation then
    update counterparties set archived_at = now(), updated_at = now() where id = p_counterparty_id;
    return 'archived';
  end;
end;
$$;

grant execute on function delete_counterparty(uuid) to authenticated;

-- ============================================================
-- 8. create_counterparty -- bikin counterparties + counterparty_type_mapping dalam 1
--    transaksi (gak ada window baris "yatim" tanpa role) -- dipakai form /customers dan
--    /suppliers (gantiin insert langsung ke tabel customers/suppliers).
-- ============================================================

create function create_counterparty(
  p_name text,
  p_role text, -- 'customer' atau 'supplier'
  p_contact text default null,
  p_payment_term_days int default 7,
  p_credit_limit numeric default null,
  p_overdue_threshold_days int default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
begin
  if p_role not in ('customer', 'supplier') then
    raise exception 'role harus customer atau supplier, dikasih: %', p_role;
  end if;

  insert into counterparties (name, contact, payment_term_days, credit_limit, overdue_threshold_days)
  values (p_name, p_contact, p_payment_term_days, p_credit_limit, p_overdue_threshold_days)
  returning id into v_id;

  insert into counterparty_type_mapping (counterparty_id, role) values (v_id, p_role);

  return v_id;
end;
$$;
