-- Ref: memory/architecture/data/document-numbering-schema.md

create table document_number_types (
  doc_type text primary key,
  prefix text not null unique,
  label text not null
);

insert into document_number_types (doc_type, prefix, label) values
  ('ap_bills', 'APB', 'AP Bill'),
  ('ap_payments', 'APP', 'AP Payment'),
  ('ap_credit_notes', 'APC', 'Retur AP — Kurangi Utang'),
  ('purchase_replacements', 'APX', 'Retur AP — Tukar Barang'),
  ('purchase_writeoffs', 'APW', 'Retur AP — Tulis-jadi-Beban'),
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
  ('item_unit_barcodes', 'SKU', 'Kode Scan Barang (item_units.barcode)');

create table document_number_counters (
  doc_type text not null references document_number_types(doc_type),
  year int not null,
  last_number int not null default 0,
  primary key (doc_type, year)
);

create or replace function generate_document_number(p_doc_type text)
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

-- RLS: gak ada policy sama sekali untuk authenticated di kedua tabel -- satu-satunya
-- jalur nulis adalah generate_document_number() (security definer, bypass RLS sebagai
-- owner). document_number_types dapat grant select eksplisit (dropdown/label UI);
-- document_number_counters gak dapat grant apa pun.
alter table document_number_types enable row level security;
alter table document_number_counters enable row level security;

grant select on document_number_types to authenticated;
