-- Status views for AP & AR deposits (filter type di atas 1 tabel deposits yang sama).
-- Ref: docs/architecture/deposits-schema.md.
--
-- Migration ini melengkapi yang sempat tertinggal: queries.ts di apps/erp sudah query
-- ke view ini sejak sesi 2026-08-16, tapi view-nya belum pernah dicreate (file migration
-- 0031/0037 yang disebut di memory/brief.md gak pernah ada di folder supabase/migrations/).
-- Pattern sama persis ar_invoices_with_status/ap_bills_with_status di 0015:
-- security_invoker = true (RLS deposits_select tetap di-enforce lewat view),
-- grant select eksplisit ke authenticated.
--
-- Kolom remaining/status di View diambil dari kolom STORED di deposits (sudah di-maintain
-- trigger recompute_deposit_status). Deposit_remaining() yang dipakai guard/trigger sama
-- caranya, jadi nilai stored-nya selalu konsisten — gak perlu cross join lateral di view.
-- counterparties(name) di queries.ts resolve lewat FK counterparty_id -> counterparties(id),
-- sama mekanisme PostgREST resource embedding kayak view invoices/bills lain.

create or replace view ap_deposits_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as supplier_id, deposit_date, source_ref, amount,
  journal_entry_id, created_at, remaining, status
from deposits
where type = 'INBOUND';

create or replace view ar_deposits_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as customer_id, deposit_date, source_ref, amount,
  journal_entry_id, created_at, remaining, status
from deposits
where type = 'OUTBOUND';

grant select on ap_deposits_with_status to authenticated;
grant select on ar_deposits_with_status to authenticated;
