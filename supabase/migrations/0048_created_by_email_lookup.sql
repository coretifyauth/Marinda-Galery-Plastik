-- "Dibuat Oleh" buat entitas transaksional utama (Invoice/Tagihan, Barang Masuk/Keluar, Uang
-- Muka) -- created_by di tabel-tabel ini uuid FK ke auth.users, yang TIDAK bisa di-query
-- langsung dari client lewat PostgREST (beda dari created_by text/email-snapshot di master
-- data kayak item_discount_rules/accounts/items). list_app_users() yang udah ada gak bisa
-- dipakai buat ini karena master-only -- admin/cashier biasa perlu lihat siapa yang bikin
-- invoice/goods note, bukan cuma master.
--
-- app_user_emails -- view MINIMAL (cuma user_id+email, gak ada role/metadata lain kayak
-- list_app_users()), gak pakai security_invoker (default: jalan sebagai owner view, bisa baca
-- auth.users) -- exposure-nya sengaja dibatasi seminimal mungkin, cuma buat resolve
-- uuid->email di UI, bukan pengganti list_app_users() buat user management.
create view app_user_emails as
select id as user_id, email::text as email from auth.users;

grant select on app_user_emails to authenticated;

-- Tambah created_by (trailing column, aman CREATE OR REPLACE VIEW -- gak retipe kolom lama).
create or replace view ar_invoices_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as customer_id, date as invoice_date, due_date, description, source_ref, amount,
  journal_entry_id, created_at, outstanding::numeric as outstanding, returned::numeric as returned,
  status, origin, created_by
from transactions
where type = 'OUTBOUND';

create or replace view ap_bills_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as supplier_id, date as bill_date, due_date, description, source_ref, supplier_document_ref,
  amount, journal_entry_id, created_at, outstanding::numeric as outstanding, status, origin, created_by
from transactions
where type = 'INBOUND';

create or replace view ap_deposits_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as supplier_id, deposit_date, source_ref, amount,
  journal_entry_id, created_at, remaining, status, created_by
from deposits
where type = 'INBOUND';

create or replace view ar_deposits_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as customer_id, deposit_date, source_ref, amount,
  journal_entry_id, created_at, remaining, status, created_by
from deposits
where type = 'OUTBOUND';
