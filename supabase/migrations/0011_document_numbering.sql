-- Document Numbering (Nomor Dokumen Otomatis) -- lihat memory/architecture/data/document-numbering-schema.md
-- Menggantikan source_ref isi-manual dengan nomor auto-generate format PREFIX-TAHUN-URUTAN,
-- reset per tahun per jenis dokumen. Frontend panggil generate_document_number(doc_type) tepat
-- sebelum RPC create yang sudah ada -- 28 RPC existing TETAP terima p_source_ref seperti sebelumnya,
-- gak ada signature yang berubah selain create_ap_bill (1 param baru, additive).

create table document_number_types (
  doc_type text primary key,
  prefix text not null unique,
  label text not null
);

create table document_number_counters (
  doc_type text not null references document_number_types(doc_type),
  year int not null,
  last_number int not null default 0,
  primary key (doc_type, year)
);

insert into document_number_types (doc_type, prefix, label) values
  ('ap_bills', 'APB', 'AP Bill'),
  ('ap_payments', 'APP', 'AP Payment'),
  ('ap_credit_notes', 'APC', 'Retur AP -- Kurangi Utang'),
  ('purchase_replacements', 'APX', 'Retur AP -- Tukar Barang'),
  ('purchase_writeoffs', 'APW', 'Retur AP -- Tulis-jadi-Beban'),
  ('ap_return_credit_refunds', 'APF', 'Refund Piutang Retur Supplier'),
  ('ap_deposits', 'APD', 'AP Deposit (DP ke Supplier)'),
  ('ap_deposit_applications', 'ADA', 'Penerapan DP AP'),
  ('ap_deposit_refunds', 'ADR', 'Refund DP AP'),
  ('ap_deposit_forfeitures', 'ADF', 'DP AP Hangus'),
  ('ar_invoices', 'ARI', 'AR Invoice'),
  ('ar_payments', 'ARP', 'AR Payment'),
  ('ar_credit_notes', 'ARC', 'Retur AR'),
  ('ar_return_credit_refunds', 'ARF', 'Refund Saldo Kredit Retur AR'),
  ('warranty_replacements', 'AWR', 'Ganti Barang Garansi AR'),
  ('ar_deposits', 'ARD', 'AR Deposit (DP dari Customer)'),
  ('ar_deposit_applications', 'RDA', 'Penerapan DP AR'),
  ('ar_deposit_refunds', 'RDR', 'Refund DP AR'),
  ('ar_deposit_forfeitures', 'RDF', 'DP AR Hangus'),
  ('ar_bad_debt_writeoffs', 'ARW', 'Write-off Piutang Tak Tertagih'),
  ('purchase_orders', 'PO', 'Purchase Order'),
  ('sales_orders', 'SO', 'Sales Order'),
  ('goods_issues', 'GI', 'Goods Issue'),
  ('production_orders', 'PRD', 'Production Order'),
  ('stock_opnames', 'SOP', 'Stock Opname'),
  ('pos_sales', 'POS', 'POS Sale'),
  ('journal_entries', 'JE', 'Journal Entry (manual)'),
  ('period_closings', 'CLS', 'Tutup Buku'),
  ('depreciation_entries', 'DEPR', 'Posting Penyusutan');

-- Satu-satunya cara resmi dapat nomor baru. security definer -- document_number_counters
-- sengaja gak ada grant/policy write sama sekali buat authenticated (lihat di bawah), jadi
-- fungsi ini butuh jalan pakai privilege pemilik fungsi buat bisa insert/update ke situ,
-- sama pola create_pos_sale (0009_pos_schema.sql). set search_path wajib di definer function
-- (anti search_path hijacking).
create function generate_document_number(p_doc_type text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year int := extract(year from now())::int;
  v_prefix text;
  v_seq int;
begin
  select prefix into v_prefix from document_number_types where doc_type = p_doc_type;
  if v_prefix is null then
    raise exception 'Unknown doc_type: %', p_doc_type;
  end if;

  insert into document_number_counters (doc_type, year, last_number)
  values (p_doc_type, v_year, 1)
  on conflict (doc_type, year)
    do update set last_number = document_number_counters.last_number + 1
  returning last_number into v_seq;

  return v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 5, '0');
end;
$$;

grant execute on function generate_document_number(text) to authenticated;

alter table document_number_types enable row level security;
alter table document_number_counters enable row level security;

-- Cuma butuh dibaca (label/prefix buat UI kalau perlu) -- gak pernah ditulis langsung dari client,
-- satu-satunya jalur nulis adalah generate_document_number() di atas.
create policy document_number_types_select on document_number_types
  for select to authenticated using (true);

-- "Automatically expose new tables" dimatikan di project settings -- tabel baru butuh grant
-- eksplisit sebelum RLS-nya kepakai PostgREST (konvensi sama semua migration lain).
grant select on document_number_types to authenticated;

-- document_number_counters sengaja gak ada select policy sama sekali -- client gak pernah perlu
-- baca counter mentah, cuma perlu hasil generate_document_number(). Default-deny RLS = ketutup total.

-- AP Bill -- dokumen eksternal (nota supplier), nomor aslinya direkam terpisah dari source_ref
-- otomatis. Lihat memory/domain/document-numbering.md submodule "Dokumen Internal vs Eksternal".
alter table ap_bills add column supplier_document_ref text;

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
