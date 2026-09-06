-- Menyelesaikan transisi POS unification ke keputusan final user (2026-09-06): data
-- pos_sales pra-cutover DIHAPUS PERMANEN, bukan dibekukan jadi *_legacy (migration 0076).
--
-- KRONOLOGI (dicatat biar gak bingung di masa depan, detail lengkap
-- memory/scope-debt/pos-unify-transactions.md): migration 0076 (versi "bekukan ke
-- *_legacy", udah lolos review schema-reviewer ronde 1-2) SUDAH KEBURU ter-apply ke
-- project live SEBELUM user memutuskan final "hapus permanen" (dan sebelum 3 fix
-- tambahan dari review ronde 3-5 ditulis) -- ketauan cuma dari histori percakapan, bukan
-- dari proses normal (kemungkinan besar salah satu sesi review yang harusnya read-only
-- ternyata sempat push). Verifikasi langsung ke DB live (2026-09-06) sebelum migration
-- ini ditulis: 0 baris `pos_sales` baru (belum ada transaksi POS nyata lewat jalur baru),
-- 8 baris `pos_sales_legacy` (riwayat pra-cutover, aman, gak tersentuh). Jadi migration
-- ini AMAN dijalankan -- gak ada data transaksional yang perlu direkonsiliasi, murni
-- lanjutan skema.
--
-- Isi migration ini = gabungan (a) keputusan "hapus permanen" yang belum kejalan
-- (drop *_legacy beneran, bukan cuma rename) dan (b) 3 fix dari review ronde 3-5 yang
-- ditulis SETELAH 0076 versi lama ter-apply, jadi belum pernah kesentuh sama sekali oleh
-- state DB sekarang: (1) inventory_movements_with_source ketinggalan gak direkreasi
-- padahal bakal ke-drop bareng pos_sales_legacy, (2) void_pos_transaction belum punya
-- baris kompensasi ke inventory_movements (kelas bug sama kayak 0056), (3) drop ordering
-- pos_sale_lines_legacy butuh CASCADE (FK aktif dari inventory_movements, 0042).

-- ============================================================
-- 1. Hapus permanen *_legacy. `pos_sale_extra_credit_lines_legacy` gak ada tabel lain
--    yang FK ke situ (dikonfirmasi ulang) -- plain drop cukup. `pos_sale_lines_legacy`
--    BUTUH cascade -- inventory_movements (0042) punya composite FK aktif
--    `foreign key (pos_sale_line_id, item_id) references pos_sale_lines(id, item_id)`
--    yang otomatis ngikutin rename 0076 (FK di Postgres tracked by OID, bukan nama) --
--    gak pernah dicabut migration manapun. `pos_sales_legacy` juga butuh cascade --
--    2 VIEW dependent (pos_sales_with_status, inventory_movements_with_source) ikut
--    kesabut, dua-duanya dibikin ulang di bagian 4/5 di bawah.
-- ============================================================

drop table if exists pos_sale_extra_credit_lines_legacy;
drop table if exists pos_sale_lines_legacy cascade;
drop table if exists pos_sales_legacy cascade;

-- Kebersihan: 2 fungsi trigger standalone dari 0053 yang badannya baca kolom
-- pos_sales_legacy/pos_sale_lines_legacy -- TABLE CASCADE gak nyabut fungsi standalone
-- (cuma trigger yang nempel ke tabel), jadi bakal jadi dead code kalau gak didrop eksplisit.
drop function if exists pos_sales_block_edit_delete_or_sync();
drop function if exists pos_sale_lines_sync_total();

-- ============================================================
-- 2. void_pos_sale -- DROP total. Data pos_sales_legacy yang jadi target fungsi ini
--    udah dihapus permanen di atas -- gak ada lagi yang bisa dibatalkan lewat jalur ini.
-- ============================================================

drop function if exists void_pos_sale(uuid, date, text);

-- ============================================================
-- 3. journal_entries_sync_reversal_status -- cabut cabang pos_sales_legacy (0076) yang
--    sekarang nunjuk ke tabel yang udah gak ada. Cabang loop transactions yang udah ada
--    di fungsi yang sama SUDAH cukup nutup POS baru (statusnya nempel di transactions).
-- ============================================================

create or replace function journal_entries_sync_reversal_status() returns trigger as $$
declare
  v_id uuid;
begin
  if new.reverses_entry_id is null then
    return new;
  end if;

  for v_id in select id from transactions where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;

  for v_id in select transaction_id from deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_transaction_status(v_id);
  end loop;
  for v_id in select deposit_id from deposit_applications where journal_entry_id = new.reverses_entry_id loop
    perform recompute_deposit_status(v_id);
  end loop;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================
-- 4. pos_sales_with_status -- single-source sekarang (pos_sales join transactions),
--    gak ada UNION legacy lagi (datanya udah gak ada). Kolom persis sama (flat, bukan
--    PostgREST embed) -- apps/erp/src/lib/pos-sales/*.ts gak perlu berubah lagi.
-- ============================================================

drop view if exists pos_sales_with_status;

create view pos_sales_with_status
  with (security_invoker = true) as
select
  t.id,
  t.date as sale_date,
  t.source_ref,
  t.journal_entry_id as revenue_journal_entry_id,
  t.amount as total,
  -- CATATAN (schema-reviewer, gak ketemu bug tapi WAJIB disadari kalau modul lain
  -- berubah): 'lunas'/'dibatalkan' doang yang mungkin muncul di sini SECARA KEBETULAN
  -- desain, bukan dijamin constraint -- record_payment selalu lunasin PENUH di RPC yang
  -- sama (outstanding pasti 0 begitu pos_sales keinsert), dan formula "excess" di RPC
  -- retur (returns-schema.md) otomatis nge-reclassify kelebihan retur jadi return_credits
  -- yang nge-add-back persis sejumlah itu, jadi outstanding TETAP di 0 berapa pun retur
  -- susulan. Kalau RPC retur/deposit BERUBAH (guard baru, atau insert manual ke
  -- returns/deposit_applications yang gak lewat reclassification ini), status
  -- 'sebagian'/'belum' BISA lolos ke sini diam-diam -- PosSaleStatus di frontend
  -- (apps/erp/src/lib/pos-sales/schema.ts) hardcode cuma 2 nilai, gak bakal nangkep itu.
  case when t.status = 'lunas' then 'normal' else t.status end as status,
  t.counterparty_id as customer_id,
  c.name as customer_name,
  ps.cash_account_id,
  ca.code as cash_account_code,
  ca.name as cash_account_name
from pos_sales ps
join transactions t on t.id = ps.transaction_id
left join counterparties c on c.id = t.counterparty_id
left join accounts ca on ca.id = ps.cash_account_id;

grant select on pos_sales_with_status to authenticated;

-- ============================================================
-- 5. inventory_movements_with_source -- WAJIB dibikin ulang di sini -- otomatis ikut
--    kesabut "drop table pos_sales_legacy cascade" di bagian 1 (view ini JOIN ke situ,
--    dependency beneran, bukan cuma FK) -- dipakai laporan Kartu Stok buat SEMUA jenis
--    mutasi (pembelian, produksi, retur, stock opname, goods issue, POS, tukar barang,
--    dst), bukan cuma POS. Tanpa migration ini, SELURUH laporan Kartu Stok 500 buat
--    SEMUA item.
--
--    Definisi asli: supabase/migrations/0075_rename_returns_and_merge_return_lines.sql.
--    SATU-SATUNYA perubahan: cabang pos_sale_line_id gak lagi JOIN ke
--    pos_sale_lines/pos_sales buat ambil source_ref -- baris lama udah dihapus permanen,
--    gak ada cara nyambungin ke data yang udah gak ada. Baris inventory_movements
--    HISTORIS (pra-cutover) yang pos_sale_line_id-nya keisi TETAP dapet label "Penjualan
--    (Kios/POS)" (baca kolom im.pos_sale_line_id is not null doang, gak butuh join),
--    tapi source_ref-nya sekarang NULL. Mutasi POS BARU (pasca-cutover) sama sekali gak
--    lewat kolom pos_sale_line_id lagi (konsumsi stok lewat create_goods_issue, set
--    goods_issue_line_id) -- otomatis kebaca label generic "Penjualan (Kirim Barang)",
--    konsekuensi wajar unifikasi (POS sekarang literal goods issue di level sistem).
-- ============================================================

drop view if exists inventory_movements_with_source;

create view inventory_movements_with_source as
select
  im.id,
  im.item_id,
  im.movement_date,
  im.qty,
  im.created_at,
  coalesce(
    case when im.goods_receipt_line_id is not null then 'Pembelian (Terima Barang)' else null end,
    case when im.production_order_id is not null then 'Produksi (Hasil)' else null end,
    case when im.return_line_id is not null and rl.type = 'INBOUND' then 'Retur dari Customer' else null end,
    case when im.stock_opname_line_id is not null then 'Penyesuaian Stock Opname' else null end,
    case when im.goods_issue_line_id is not null then 'Penjualan (Kirim Barang)' else null end,
    case when im.pos_sale_line_id is not null then 'Penjualan (Kios/POS)' else null end,
    case when im.production_order_line_id is not null then 'Produksi (Konsumsi Bahan)' else null end,
    case when im.return_line_id is not null and rl.type = 'OUTBOUND' then 'Retur ke Supplier' else null end,
    case when im.warranty_replacement_line_id is not null then 'Penggantian Garansi' else null end,
    case when im.purchase_replacement_line_id is not null then 'Tukar Barang (Retur Supplier)' else null end
  ) as source_label,
  coalesce(ap_bill.source_ref, prod_header.source_ref, r.source_ref, so.source_ref, gi.source_ref, prod_line_header.source_ref, wr.source_ref, pr.source_ref) as source_ref
from inventory_movements im
  left join goods_receipt_lines grl on grl.id = im.goods_receipt_line_id
  left join goods_receipt_notes grn on grn.id = grl.grn_id
  left join transactions ap_bill on ap_bill.id = grn.bill_id
  left join production_orders prod_header on prod_header.id = im.production_order_id
  left join return_lines rl on rl.id = im.return_line_id
  left join returns r on r.id = rl.return_id
  left join stock_opname_lines sol on sol.id = im.stock_opname_line_id
  left join stock_opnames so on so.id = sol.stock_opname_id
  left join goods_issue_lines gil on gil.id = im.goods_issue_line_id
  left join goods_issues gi on gi.id = gil.goods_issue_id
  left join production_order_lines pol on pol.id = im.production_order_line_id
  left join production_orders prod_line_header on prod_line_header.id = pol.production_order_id
  left join warranty_replacement_lines wrl on wrl.id = im.warranty_replacement_line_id
  left join warranty_replacements wr on wr.id = wrl.warranty_replacement_id
  left join purchase_replacement_lines prpl on prpl.id = im.purchase_replacement_line_id
  left join purchase_replacements pr on pr.id = prpl.purchase_replacement_id;

grant select on inventory_movements_with_source to authenticated;

-- ============================================================
-- 6. void_pos_transaction -- tambah baris kompensasi ke inventory_movements (Kartu
--    Stok) pas void, kelas bug SAMA PERSIS yang migration 0056 perbaiki buat
--    void_pos_sale lama: tanpa ini, inventory_balances.qty_on_hand benar tapi
--    SUM(inventory_movements.qty) drift permanen (ledger tetap nunjukin barang "keluar"
--    buat transaksi yang udah dibatalkan). Sumbernya goods_issue_line_id (bukan
--    pos_sale_line_id -- POS baru konsumsi stok lewat create_goods_issue).
-- ============================================================

create or replace function void_pos_transaction(
  p_transaction_id uuid,
  p_entry_date date,
  p_source_ref text
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_pos record;
  v_transaction_journal_entry_id uuid;
  v_goods_issue_journal_entry_id uuid;
  v_payment_journal_entry_id uuid;
  v_already_voided boolean;
  v_new_entry_id uuid;
  v_line record;
begin
  select * into v_pos from pos_sales where transaction_id = p_transaction_id;
  if not found then
    raise exception 'Transaksi % bukan POS sale (gak ada penanda pos_sales) -- pakai cancel_ar_invoice', p_transaction_id;
  end if;

  select journal_entry_id into v_transaction_journal_entry_id from transactions where id = p_transaction_id;
  select journal_entry_id into v_goods_issue_journal_entry_id from goods_issues where id = v_pos.goods_issue_id;
  select journal_entry_id into v_payment_journal_entry_id from payments where id = v_pos.payment_id;

  select exists (
    select 1 from journal_entries je where je.reverses_entry_id = v_transaction_journal_entry_id
  ) into v_already_voided;

  if v_already_voided then
    raise exception 'POS sale % udah pernah dibatalkan', p_transaction_id;
  end if;

  -- Urutan: payment dulu (Kas<->Piutang), goods_issue (HPP<->Persediaan), baru
  -- transaction (Piutang<->Pendapatan) -- reverse_journal_entry gak peduli urutan
  -- (masing-masing independen), tapi urutan ini paling gampang dibaca di riwayat jurnal.
  perform reverse_journal_entry(v_payment_journal_entry_id, p_entry_date, p_source_ref);
  perform reverse_journal_entry(v_goods_issue_journal_entry_id, p_entry_date, p_source_ref);
  v_new_entry_id := reverse_journal_entry(v_transaction_journal_entry_id, p_entry_date, p_source_ref);

  update inventory_balances ib
    set qty_on_hand = ib.qty_on_hand + agg.qty_issued,
        updated_at = now()
    from (
      select item_id, sum(qty_issued) as qty_issued
      from goods_issue_lines
      where goods_issue_id = v_pos.goods_issue_id
      group by item_id
    ) agg
    where ib.item_id = agg.item_id;

  for v_line in select id, item_id, qty_issued from goods_issue_lines where goods_issue_id = v_pos.goods_issue_id loop
    insert into inventory_movements (item_id, movement_date, qty, goods_issue_line_id)
    values (v_line.item_id, p_entry_date, v_line.qty_issued, v_line.id);
  end loop;

  return v_new_entry_id;
end;
$$;
