-- 0066_report_sales_purchase_monthly.sql
-- Dashboard Penjualan & Pembelian: satu fungsi baca, satu baris per bulan. Tanpa tabel baru, tanpa penulisan.
-- Konsep: docs/domain/financial-reports.md "Dashboard Penjualan & Pembelian"; struktur: docs/architecture/financial-reports-schema.md.
--
-- Definisi (keputusan owner 2026-11-03):
--   * Penjualan/HPP/diskon: transaksi OUTBOUND yang status-nya bukan 'dibatalkan', per bulan tanggal dokumen.
--   * Penjualan barang = baris transaction_lines non-pajak yang akunnya BUKAN kategori biaya tambahan (charge_categories module 'ar' dan 'pos'),
--     dan HANYA dari transaksi yang punya barang keluar (goods_notes OUTBOUND) -- invoice AR manual tanpa barang (jasa dsb) tidak punya HPP,
--     jadi kalau ikut terhitung margin membengkak.
--   * Retur dihitung di bulan retur dibuat (credit_note_date), bukan bulan dokumen asal.
--   * Pembelian = nilai bersih barang masuk aktif (goods_receipts_overview) per bulan note_date, BUKAN tanggal tagihan.
--   * Retur ke supplier = returns OUTBOUND yang masih aktif (return_is_active), per bulan credit_note_date.
-- security invoker: RLS tabel sumber tetap berlaku. Bulan tanpa transaksi tetap muncul dengan nol.

create or replace function report_sales_purchase_monthly(
  p_from date,
  p_to date
)
returns table (
  month date,
  sales_goods numeric,
  discount numeric,
  sales_return numeric,
  hpp numeric,
  hpp_returned numeric,
  purchases numeric,
  purchase_return numeric
)
language sql
stable
security invoker
as $$
  with bounds as (
    select date_trunc('month', p_from)::date as d_from,
           (date_trunc('month', p_to) + interval '1 month')::date as d_to -- eksklusif
  ),
  months as (
    select generate_series(b.d_from, b.d_to - 1, interval '1 month')::date as m from bounds b
  ),
  sales as (
    select date_trunc('month', t.date)::date as m,
           coalesce(sum(tl.amount), 0) as v
    from transactions t
    join transaction_lines tl on tl.transaction_id = t.id
    cross join bounds b
    where t.type = 'OUTBOUND' and t.status <> 'dibatalkan'
      and t.date >= b.d_from and t.date < b.d_to
      and not tl.is_tax
      and tl.account_id not in (select account_id from charge_categories where module in ('ar', 'pos'))
      and exists (select 1 from goods_notes gn where gn.transaction_id = t.id and gn.type = 'OUTBOUND')
    group by 1
  ),
  disc as (
    select date_trunc('month', t.date)::date as m, coalesce(sum(t.discount_amount), 0) as v
    from transactions t
    cross join bounds b
    where t.type = 'OUTBOUND' and t.status <> 'dibatalkan'
      and t.date >= b.d_from and t.date < b.d_to
      and exists (select 1 from goods_notes gn where gn.transaction_id = t.id and gn.type = 'OUTBOUND')
    group by 1
  ),
  cost as (
    select date_trunc('month', gn.note_date)::date as m, coalesce(sum(gl.total_cost), 0) as v
    from goods_notes gn
    join transactions t on t.id = gn.transaction_id
    join goods_note_lines gl on gl.goods_note_id = gn.id
    cross join bounds b
    where gn.type = 'OUTBOUND' and t.status <> 'dibatalkan'
      and gn.note_date >= b.d_from and gn.note_date < b.d_to
    group by 1
  ),
  ar_ret as (
    select date_trunc('month', r.credit_note_date)::date as m, coalesce(sum(r.amount), 0) as v
    from returns r
    cross join bounds b
    where r.type = 'INBOUND' and r.credit_note_date >= b.d_from and r.credit_note_date < b.d_to
    group by 1
  ),
  ar_ret_hpp as (
    select date_trunc('month', r.credit_note_date)::date as m, coalesce(sum(rl.total_cost), 0) as v
    from returns r
    join return_lines rl on rl.return_id = r.id
    cross join bounds b
    where r.type = 'INBOUND' and rl.hpp_reversal_journal_entry_id is not null
      and r.credit_note_date >= b.d_from and r.credit_note_date < b.d_to
    group by 1
  ),
  buy as (
    select date_trunc('month', g.note_date)::date as m, coalesce(sum(g.total_value), 0) as v
    from goods_receipts_overview g
    cross join bounds b
    where g.status = 'aktif' and g.note_date >= b.d_from and g.note_date < b.d_to
    group by 1
  ),
  ap_ret as (
    select date_trunc('month', r.credit_note_date)::date as m, coalesce(sum(r.amount), 0) as v
    from returns r
    cross join bounds b
    where r.type = 'OUTBOUND' and return_is_active(r.id)
      and r.credit_note_date >= b.d_from and r.credit_note_date < b.d_to
    group by 1
  )
  select
    mo.m,
    coalesce(s.v, 0), coalesce(d.v, 0), coalesce(ar.v, 0), coalesce(c.v, 0),
    coalesce(arh.v, 0), coalesce(bu.v, 0), coalesce(apr.v, 0)
  from months mo
  left join sales s on s.m = mo.m
  left join disc d on d.m = mo.m
  left join cost c on c.m = mo.m
  left join ar_ret ar on ar.m = mo.m
  left join ar_ret_hpp arh on arh.m = mo.m
  left join buy bu on bu.m = mo.m
  left join ap_ret apr on apr.m = mo.m
  order by mo.m
$$;

grant execute on function report_sales_purchase_monthly(date, date) to authenticated;
