-- 0059_goods_receipts_overview.sql
-- View baca saja untuk daftar/detail Barang Masuk (INBOUND): menggantikan goods_notes_with_billing_status yang
-- dibuang 0058. Status turunan cuma 'aktif' / 'dibatalkan' (gak ada lagi "belum tertagih" -- barang masuk selalu
-- dibuat dari satu tagihan barang). Struktur data: docs/architecture/goods-notes-schema.md section
-- "Barang Masuk dari Tagihan". Gak mengubah data apa pun.
--
-- status:
--   * dibatalkan : ada baris di goods_note_cancellations, ATAU barang masuk lama (journal_entry_id NULL, jurnal
--                  Persediaan ada di tagihannya) yang tagihannya sudah dibatalkan (pembatalan tagihan lama membalik stok);
--   * aktif      : selain itu.
-- bill_id/bill_ref/bill_amount : tagihan induk (NULL hanya untuk riwayat alur lama yang dibatalkan).
-- is_legacy    : barang masuk lama yang dibuat bareng tagihannya (nomor GRN kosong, tampilkan nomor tagihan).
-- total_value  : jumlah nilai bersih baris = round(qty x unit_cost, 2) - discount_amount (sama dengan yang dijurnal).

-- Supabase CLI menjalankan tiap statement TERPISAH (bukan satu transaksi per file) -- transaksi harus eksplisit supaya gagal di tengah = batal semua.
begin;

create view goods_receipts_overview
  with (security_invoker = true) as
select
  gn.id,
  gn.counterparty_id,
  cp.name as supplier_name,
  gn.note_date,
  gn.source_ref,
  gn.delivery_note_ref,
  gn.order_id,
  o.source_ref as order_ref,
  gn.transaction_id as bill_id,
  bt.source_ref as bill_ref,
  bt.amount as bill_amount,
  (gn.journal_entry_id is null) as is_legacy,
  case
    when c.goods_note_id is not null then 'dibatalkan'
    when gn.journal_entry_id is null and bt.status = 'dibatalkan' then 'dibatalkan'
    else 'aktif'
  end as status,
  coalesce(v.total_value, 0) as total_value,
  gn.created_at,
  gn.created_by
from goods_notes gn
left join counterparties cp on cp.id = gn.counterparty_id
left join orders o on o.id = gn.order_id
left join transactions bt on bt.id = gn.transaction_id
left join goods_note_cancellations c on c.goods_note_id = gn.id
left join lateral (
  select sum(round(l.qty * l.unit_cost, 2) - coalesce(l.discount_amount, 0)) as total_value
  from goods_note_lines l
  where l.goods_note_id = gn.id
) v on true
where gn.type = 'INBOUND';

grant select on goods_receipts_overview to authenticated;

-- ap_bills_with_status -- tambah has_goods_pool (kolom baru di ujung): tagihan barang (punya kolam) vs tagihan lain.
-- `origin` dihitung dari barang masuk, jadi tagihan barang yang belum ada barang masuknya masih 'financial_only';
-- daftar tagihan memakai has_goods_pool untuk label/filter tipe "Tagihan Barang".
create or replace view ap_bills_with_status
  with (security_invoker = true) as
select
  id, counterparty_id as supplier_id, date as bill_date, due_date, description, source_ref, supplier_document_ref,
  amount, journal_entry_id, created_at, outstanding::numeric as outstanding, status, origin, created_by,
  exists (select 1 from ap_bill_goods_pools p where p.transaction_id = transactions.id) as has_goods_pool
from transactions
where type = 'INBOUND';

commit;
