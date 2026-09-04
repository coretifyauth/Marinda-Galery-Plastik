# Gabung `ar_invoices`+`ap_bills` jadi 1 tabel `transactions` (`type` INBOUND/OUTBOUND)

**Modul asal:** cross-cutting (AR, AP, dan pemanggilnya di Inventory — `create_goods_issue`/`create_goods_receipt`). Hasil diskusi eksplorasi arsitektur dengan user (2026-09-05), bukan gap yang ketemu pas bangun fitur. **Status:** Ditunda — butuh 1 keputusan owner (singkirkan Credit Hold) sebelum bisa mulai, dan belum ada tekanan kebutuhan konkret buat digarap sekarang.

Menggantikan draft awal (`journal-account-determination.md`, ide "tabel journal template" generik) — setelah `create_ar_invoice`/`create_ap_bill` dibaca langsung side-by-side, ternyata bentuknya JAUH lebih dekat buat digabung daripada draft awal ngira. Ide "journal template" sendiri gak dilanjutkan sebagai item terpisah — kebutuhannya udah kejawab jadi bagian desain RPC `create_transaction` di bawah.

## Kasus

Diskusi bermula dari pertanyaan kenapa `ar_invoices`+`ap_bills` gak bisa digeneralisasi kayak `purchase_orders`+`sales_orders` jadi `orders` (`memory/architecture/data/inventory-schema.md` submodule "Purchase Order & Sales Order"). Klaim awal (dari eksplorasi pertama): AR dan AP beda substansi akuntansi, gak mungkin digabung. Setelah dibedah lebih dalam pakai kode aktual (`create_ar_invoice`/`create_ap_bill`, `supabase/migrations/0059_counterparty_schema.sql:241-461`), klaim itu ternyata KELIRU di 1 poin penting:

**Perbandingan struktur jurnal langsung dari kode:**

```
create_ar_invoice:                          create_ap_bill:
  1 baris FIXED:   Debit Piutang (total)       1 baris FIXED:   Kredit Utang (total)
  N baris VARIABEL: Kredit kategori...         N baris VARIABEL: Debit kategori...
  1 baris opsional: Kredit PPN Keluaran        1 baris opsional: Debit PPN Masukan
```

Ini cermin sempurna — cuma beda arah debit/kredit, bisa digenericin lewat 1 kolom `type`.

**Klaim lama soal "AR bikin 2 jurnal, AP cuma 1" itu SALAH ATRIBUSI** — jurnal ganda (HPP/Persediaan) itu punya `create_goods_issue`, BUKAN `create_ar_invoice`. `create_goods_issue` **MEMANGGIL** `create_ar_invoice(...)` di dalamnya, baru abis itu bikin 1 jurnal HPP terpisah sendiri — persis pola `create_goods_receipt` yang **MEMANGGIL** `create_ap_bill(...)` di dalamnya. Di level `ar_invoices`/`ap_bills` sendiri (bukan level pemanggilnya), jurnalnya SUDAH simetris (1 masing-masing).

**Sisa asimetri nyata, cuma 2:**
1. **Credit Hold** (`create_ar_invoice` doang) — query outstanding semua invoice customer + cek `counterparties.credit_limit`/`overdue_threshold_days`, `raise exception` kalau kelewat. `create_ap_bill` gak punya sama sekali.
2. **`ap_bills.supplier_document_ref`** — 1 kolom nullable ekstra (nomor nota asli supplier), gak ada padanan di `ar_invoices`. Kecil, gampang ditoleransi sebagai kolom nullable yang cuma keisi kalau `type='OUTBOUND'`.

## Kenapa ditunda

1. **Prasyarat: keputusan owner soal Credit Hold belum ada.** Fitur ini (`ar_bad_debt_writeoffs` + `counterparties.credit_limit`/`overdue_threshold_days` + check di `create_ar_invoice`) HARUS disingkirkan dulu biar `create_ar_invoice`/`create_ap_bill` beneran simetris — ini keputusan PRODUK (ngilangin kemampuan formal nolak invoice yang ngelewatin plafon kredit / nyatet piutang tak tertagih), bukan keputusan teknis semata. Belum diputuskan.
2. **Blast radius migrasi LEBIH GEDE dari `orders`** — `orders` cuma punya sedikit dependent (karena PO/SO dulu belum ada jurnal). `ar_invoices`/`ap_bills` udah ada jurnal DAN udah punya **11 tabel turunan** yang FK ke situ: `ar_payments`, `ar_credit_notes`, `ar_deposits`, `ar_return_credits`, `ar_invoice_credit_lines` (+ `ar_bad_debt_writeoffs` kalau fiturnya gak jadi disingkirkan) di sisi AR; `ap_payments`, `ap_credit_notes`, `ap_deposits`, `ap_return_credits`, `ap_bill_debit_lines` di sisi AP. Semua butuh repoint FK + trigger + view disesuaikan — pola teknisnya udah ada (`_repoint_fk_to_counterparties`/`_repoint_fk`, `0059`/`0060`), tapi jumlah tabel yang kena jauh lebih banyak.
3. **Belum ada tekanan kebutuhan konkret** — murni ide eksplorasi arsitektur, belum ada bug/duplikasi yang beneran mengganggu development sehari-hari.

## Rencana Bertahap (kalau nanti digarap — bukan cetak biru final)

Dikelompokkan jadi fase yang bisa di-batch, urutan ada dependency (fase belakang butuh fase sebelumnya kelar) — pola sama `order-generalization.md` (sudah closed, jadi preseden format).

```
Fase 1: Keputusan & Desain     -- prasyarat non-teknis + rancangan schema, belum ada kode jalan
Fase 2: RPC Layer              -- RPC baru dibikin & pemanggil internal diganti, BELUM sentuh data lama
Fase 3: Migrasi Struktural     -- tabel/FK/trigger/view lama diganti beneran, paling berisiko
Fase 4: Sweep Permukaan        -- frontend + laporan, mekanis tapi lebar
```

### Fase 1 — Keputusan & Desain
1. **Keputusan owner: singkirkan Credit Hold** (`ar_bad_debt_writeoffs` + `counterparties.credit_limit`/`overdue_threshold_days` + check di `create_ar_invoice`) — **gerbang wajib**, gak ada langkah lain yang boleh mulai sebelum ini diputuskan. Kalau owner milih PERTAHANKAN fitur ini, seluruh rencana berhenti di sini (Credit Hold jadi 1 baris kondisional ekstra yang cuma jalan kalau `type='INBOUND'` — masih tolerable, tapi ngerusak kebersihan "generic murni", perlu didiskusikan ulang trade-off-nya kalau ini yang kejadian).
2. **Desain schema `transactions`+`transaction_lines`** — mirror `orders`+`order_lines`: kolom union dari `ar_invoices`+`ap_bills` (`counterparty_id`, `type` `'INBOUND'`/`'OUTBOUND'`, `date`, `description`, `source_ref`, `amount`, `due_date`, `outstanding`/`status`/`origin` denormalized, `journal_entry_id`, `supplier_document_ref` nullable cuma keisi `OUTBOUND`). Output fase ini murni dokumen desain (DDL rancangan), belum ada migration ditulis.

### Fase 2 — RPC Layer
3. **RPC `create_transaction(p_type, p_counterparty_id, p_lines, p_control_account_id, p_apply_tax, p_supplier_document_ref default null)`** gantiin `create_ar_invoice`+`create_ap_bill` — cabang `if p_type='INBOUND'` cuma nentuin arah baris FIXED vs VARIABEL/PPN (persis pola `create_order(p_direction,...)`). Bisa ditulis & di-review duluan sebelum tabel lama beneran diganti (RPC baru jalan paralel, `ar_invoices`/`ap_bills` lama masih ada).
4. **Update pemanggil**: `create_goods_issue` ganti manggil `create_transaction('INBOUND', ...)` gantiin `create_ar_invoice(...)` — jurnal HPP/Persediaan-nya SENDIRI TETAP TERPISAH, gak kesentuh sama sekali. `create_goods_receipt` sama, ganti ke `create_transaction('OUTBOUND', ...)` gantiin `create_ap_bill(...)`.

### Fase 3 — Migrasi Struktural (paling berisiko, butuh review `schema-reviewer` paling ketat)
5. **Backfill `transactions`/`transaction_lines` dari `ar_invoices`+`ap_bills` PAKAI ID ASLI** (pola sama Fase 1 `order-generalization` — `counterparties`/`0059` — biar tabel turunan cukup di-repoint constraint-nya, gak perlu backfill data per-baris).
6. **Repoint FK 11 tabel turunan** ke `transactions`: `ar_payments`, `ar_credit_notes`, `ar_deposits`, `ar_return_credits`, `ar_invoice_credit_lines` (+ `ar_bad_debt_writeoffs` kalau ternyata gak jadi disingkirkan di Fase 1) di sisi AR; `ap_payments`, `ap_credit_notes`, `ap_deposits`, `ap_return_credits`, `ap_bill_debit_lines` di sisi AP — pakai fungsi generalisasi `_repoint_fk` yang udah ada (dari `0060`).
7. **Trigger `recompute_transaction_status` gabungan** (gantiin `recompute_ar_invoice_status`+`recompute_ap_bill_status`) + **2 view TETAP terpisah** (`ar_invoices_with_status`/`ap_bills_with_status`, difilter `type` di atas 1 tabel `transactions`) — mirror deviasi sengaja yang udah dipakai `orders` (`0060`), biar `queries.ts` existing gak perlu diubah namanya.
8. **Drop `ar_invoices`+`ap_bills` lama** — di migration TERPISAH dari langkah 5-7 (pola sama `0062` yang lagi disiapkan buat `customers`/`suppliers`: jeda observasi dulu sebelum drop beneran, bukan sekali jalan).

### Fase 4 — Sweep Permukaan
9. **Sweep frontend** — jauh lebih lebar dari `orders` (AR+AP nyentuh lebih banyak halaman: invoice, payment, deposit, credit note, retur, plus cross-module di goods-issue/goods-receipt/pos). Bisa dipecah lagi per-sub-modul kalau dikerjain (misal: AR dulu, AP nyusul, atau sebaliknya).
10. **Update laporan keuangan** (Aging AR, Aging AP, Buku Besar, Trial Balance) — tambah filter `type` di query yang sebelumnya implisit asumsi "1 tabel = 1 arah".

## Referensi

- `memory/architecture/data/ar-schema.md` — `create_ar_invoice` (definisi terkini: `supabase/migrations/0059_counterparty_schema.sql:241-364`), `ar_invoice_remaining()`, Credit Hold.
- `memory/architecture/data/ap-schema.md` — `create_ap_bill` (definisi terkini: `supabase/migrations/0059_counterparty_schema.sql:371-461`), `ap_bill_remaining()`.
- `memory/architecture/data/inventory-schema.md` submodule "Purchase Order & Sales Order (`orders`)" — preseden generalisasi PO+SO, pola `_repoint_fk`, dan deviasi "2 view tetap terpisah" yang jadi rujukan langkah 6 di atas. Juga tempat `create_goods_issue`/`create_goods_receipt` (pemanggil `create_ar_invoice`/`create_ap_bill`) didefinisikan.
