# Memory Brief — Entry Point (untuk Claude)

Peta seluruh `/memory`. Baca ini duluan tiap orientasi ulang — sebelum baca kode atau `/docs`.

`/memory` adalah context compact buat agent (Claude). Beda dari `/docs` (lihat `docs/brief.md`) yang naratif buat manusia — kontennya sering sama topik, tapi `/memory` lebih padat, teknis, dan boleh nyebut nama tabel/kolom/RPC/trigger langsung.

## Struktur

```
/memory
  brief.md               <- file ini
  /domain                 <- knowledge bisnis/akuntansi, versi compact context (padanan: docs/domain/)
  /architecture
    /app                  <- keputusan level aplikasi (stack, konvensi kode)
    /data                 <- ERD, skema, DDL, RPC, trigger — versi teknis penuh (padanan naratif: docs/architecture/)
  /preferences
    /system               <- preferensi level sistem (naming, konvensi non-UI)
    /ui                   <- preferensi UI/UX & behavior design
  /rules                  <- mental model wajib agent SEBELUM bangun fitur (belum ada file, diisi saat pertama kali dibutuhkan)
  /scope-debt             <- keputusan desain yang sengaja ditunda lintas modul, 1 file per konsep
```

Konvensi penamaan file: kebab-case deskriptif, tanpa prefix nomor — `memory/preferences/system/md-file-naming.md`. Nama file sama antara `memory/domain/*.md` dan `docs/domain/*.md` (padanan compact vs naratif).

## Aturan siklus hidup dokumen (wajib dipatuhi)

1. **Scope-debt selesai → file dihapus.** Begitu sebuah item di `memory/scope-debt/` beres diimplementasi (status berubah jadi "Selesai" di file itu), hapus filenya — jangan dibiarin numpuk sebagai arsip. Riwayat keputusan tetap ada di git history + migration file, gak perlu didup dua di scope-debt.
2. **Referensi ke scope-debt yang dihapus wajib dibersihkan.** File di `memory/domain/*.md`, `docs/domain/*.md`, atau `memory/architecture/data/*.md` yang nyebut nama file scope-debt yang baru dihapus harus diupdate — hapus link matinya, ringkasan keputusannya cukup tetap ada inline (biasanya udah ada, karena scope-debt cuma nyimpen rationale, bukan satu-satunya sumber info).
3. **`memory/architecture/data/*.md` dan `docs/architecture/*.md` adalah 2 dokumen terpisah, bukan 1 file yang di-link.** Isi harus konsisten (ERD & keputusan yang sama), tapi bahasa & level detail beda — lihat `memory/preferences/system/schema-doc-format.md`.
4. **Section "Belum Termasuk"/"Belum termasuk" (tiap file `docs/architecture/*.md` dan `memory/architecture/data/*.md`) punya aturan siklus hidup yang sama kayak scope-debt, cuma levelnya per-item bukan per-file.** Begitu 1 item di situ beres diimplementasi — **oleh fitur APA PUN**, bukan cuma fitur yang lagi dikerjain sekarang, termasuk fitur yang dibangun modul/sesi lain — item itu harus dihapus dari SEMUA file yang nyebutnya (bisa lebih dari 1: `docs/architecture/X.md`, `memory/architecture/data/X.md`, kadang juga `docs/domain/X.md`/`memory/domain/X.md`). **Jangan cuma cek file yang lagi diedit** — begitu selesai bangun fitur baru, grep keyword-nya ke seluruh 4 folder (`docs/architecture`, `memory/architecture/data`, `docs/domain`, `memory/domain`) buat nemuin exclusion note lama yang sekarang udah gak akurat, walau di file yang gak lagi disentuh. Ketauan pertama kali item di `ar-schema.md` gak ke-update pas fitur retur-credit dibangun (2026-08-05), dan terpisah item lama di `journal-entry-schema.md` soal Period Closing yang udah lama selesai (Fase 7) tapi gak pernah dibersihin.

## Isi saat ini

### domain/
Compact context version dari 7 modul (chart-of-accounts, general-ledger, accounts-receivable, accounts-payable, inventory, fixed-assets, financial-reports). Tiap file nyimpen: aturan/constraint teknis, keputusan desain + rationale singkat, dan link balik ke naratif lengkap di `docs/domain/*.md`. Jangan generate ulang logic yang udah tercatat di sini — load sebagai context dulu sebelum implement ulang.

### architecture/app/
- `tech-stack-decisions.md` — Supabase (Postgres+Auth+RLS) dipilih, drop Prisma & NextAuth, impact ke tiap modul. Juga keputusan: Journal Entry gak pakai draft/posted workflow.

### architecture/data/
DDL final + trigger + RPC tiap modul, level teknis penuh:
- `coa-schema.md` — `accounts`, `roles`, `user_roles` + RLS, `normal_balance` generated column, `is_contra` flag, published-lock & leaf-only-posting trigger.
- `journal-entry-schema.md` — `journal_entries`+`journal_lines`, 5 trigger, RPC `create_journal_entry`+`reverse_journal_entry`.
- `ar-schema.md` — `customers`+`ar_invoices`+`ar_payments`+`ar_payment_allocations`, RPC `create_ar_invoice`+`record_ar_payment`+`cancel_ar_invoice`. **AR Credit Note (retur, `0021_ar_credit_notes_schema.sql`)**: `ar_credit_notes` (selalu) + `inventory_returns`/`inventory_return_lines` (cuma kalau invoice lewat `create_goods_issue`), RPC `create_ar_credit_note` — auto-detect jalur financial-only vs full (stok+HPP balik). Nambah `items.return_window_days` (batas hari retur per item) + `inventory_lots.source_type` value baru `SALES_RETURN`.
- `ap-schema.md` — `suppliers`+`ap_bills`+`ap_payments`+`ap_payment_allocations`, mirror AR arah kebalik. **AP Credit Note (retur, `0035_ap_credit_notes_schema.sql`)**: 2 resolusi SALING EKSKLUSIF (beda dari AR yang additive) — Opsi A `create_ap_credit_note` (kurangi Utang Usaha, tanpa akun kontra, excess otomatis jadi `ap_return_credits`/Piutang Retur Supplier akun `1350` kalau bill udah lunas) vs Opsi B `create_purchase_replacement` (tukar barang, berdiri sendiri, gak nyentuh Utang Usaha). `ap_bill_remaining()` disentralisasi dari awal (beda dari AR yang baru belakangan). Cuma nanganin item Weighted Average (FIFO diabaikan, `memory/scope-debt/penghapusan-fifo.md`). Proses desainnya nemuin cacat di AR `warranty_replacement` (additive, kompensasi ganda) — sudah diperbaiki lewat `0037_ar_warranty_replacement_discount_reversal.sql` (lihat item selesai di bawah).
- `inventory-schema.md` — `items`+`inventory_balances`, `purchase_orders`+`goods_receipt_notes`, `inventory_lots`+`inventory_lot_consumptions` (FIFO), `bom_headers`+`production_orders`, `goods_issues`. RPC `create_purchase_order`, `create_goods_receipt`, `create_production_order`, `create_goods_issue`.
- `fixed-assets-schema.md` — `accounts.is_contra`, `fixed_assets`+`depreciation_entries`. RPC `create_fixed_asset`, `post_depreciation`.
- `financial-reports-schema.md` — 4 laporan (Trial Balance/Income Statement/Balance Sheet/Cash Flow) **gak ada tabel baru**, read layer di atas `accounts`+`journal_entries`+`journal_lines`, fetch+reduce di TypeScript (bukan RPC/SQL view/PostgREST aggregate — aggregate gak aktif di project ini, dites langsung). `getIncomeStatement` exclude baris closing entry (`fetchClosingJournalEntryIds()`) biar re-query periode yang udah ditutup tetap nunjukin angka historis, bukan 0 — Trial Balance/Balance Sheet sengaja gak ikut exclude. `memory/scope-debt/trial-balance-rollup.md` masih terbuka (soal performa skala besar). **Period Closing** (`0016_period_closing.sql`) beda — financial write beneran: tabel `period_closings` (ledger rentang tertutup, append-only), trigger tolak entry baru masuk rentang tertutup, RPC `close_period` (hitung Revenue/Expense dari `journal_lines` langsung, nol-in via closing entry, gak percaya angka client). Gak ada reopen.

Padanan naratif non-teknis (ERD dalam tabel, tanpa DDL/RPC/trigger mentah): `docs/architecture/*.md`.

### preferences/system/
- `state-naming-convention.md` — `archived` (soft-delete) vs `published` (derived, locked-state).
- `md-file-naming.md` — konvensi penamaan file `.md`.
- `schema-doc-format.md` — format wajib tiap schema doc.

### preferences/ui/
- `admin-shell-design.md` — layout sidebar+topbar+breadcrumb, pola entity detail page.
- `form-components.md` — komponen form reusable di `src/components/ui/`.

### rules/
(belum ada — diisi saat pertama kali dibutuhkan, lihat `AGENTS.md`)

### scope-debt/
Ledger keputusan desain yang sengaja ditunda. 1 file = 1 konsep: kasus, kenapa ditunda, kapan perlu digarap, referensi balik ke domain/schema doc terkait. **Dihapus begitu statusnya jadi Selesai** (lihat "Aturan siklus hidup dokumen" di atas).

Status saat ini — semua di bawah ini masih **Ditunda**:
- `ap-diskon-bayar-cepat.md`, `ap-uang-muka-dp.md`, `ap-bill-compound.md` — 3 kasus AP (Fase 4) yang masih Ditunda.
- `trial-balance-rollup.md` — dependency GL ke Fase 7.
- `user-role-admin-assignment.md` — policy admin assign role, butuh `security definer` function.
- `kerugian-barang-rusak.md` — lintas modul AR & AP, barang rusak yang di-retur harusnya diakui Beban Kerugian Barang Rusak (write-off), bukan masuk lagi jadi stok bernilai. Ketauan pas desain AP Retur Barang (2026-08-06).
- `penghapusan-fifo.md` — rencana hapus metode costing FIFO dari sistem (cuma sisain Weighted Average), berdampak ke `inventory_lots`/`consume_fifo`/AR retur full/AP retur. Dicatat pas desain AP Retur Barang (2026-08-06), belum dikerjakan ("soon").
- `ui-detail-page-retrofit.md` — 9 halaman list (`journal-entries`, `ar-payments`, `ap-bills`, `ap-payments`, `purchase-orders`, `goods-receipts`, `production-orders`, `bom`, `goods-issues`) belum punya detail page sesuai aturan wajib baru (`memory/preferences/ui/admin-shell-design.md`), + catatan terkait `fixed-assets` yang aksinya belum dipindah ke detail page-nya.

(Item `fixed-assets-akun-kontra-asset.md` sudah **Selesai** — diapply di migration `0014_fixed_assets_schema.sql`. Item `period-closing.md` sudah **Selesai** — diapply di migration `0016_period_closing.sql`. Item `income-statement-closing-entry-self-cancel.md` sudah **Selesai** — `getIncomeStatement` sekarang exclude baris closing entry lewat `fetchClosingJournalEntryIds()` (`src/lib/reports/period-closing.ts`). Item `ar-credit-hold.md` sudah **Selesai** — diapply di migration `0020_ar_credit_hold.sql` (`customers.credit_limit`/`overdue_threshold_days` + validasi di `create_ar_invoice`). Item `ar-retur-barang.md` sudah **Selesai** — schema+RPC di migration `0021_ar_credit_notes_schema.sql` (bugfix `0022_fix_ar_credit_note_lot_source_ref.sql`, seed `0023_seed_demo_ar_credit_notes.sql`), UI-nya panel retur inline di `src/app/(app)/ar-invoices/page.tsx` (tombol "Retur" per baris invoice, RPC `create_ar_credit_note`). Item `ar-uang-muka-dp.md` sudah **Selesai** — diapply di migration `0024_ar_deposits_schema.sql` (3 tabel baru `ar_deposits`/`ar_deposit_applications`/`ar_deposit_forfeitures`, RPC `create_ar_deposit`/`apply_ar_deposit`/`forfeit_ar_deposit`, `cancel_ar_invoice` diperluas auto-unwind DP-application, akun COA baru `2300`/`4300` + seed `0025_seed_demo_ar_deposits.sql`), UI-nya halaman baru `/ar-deposits` (list+create) + `/ar-deposits/[id]` (detail, aksi "Hanguskan" di situ — sesuai aturan wajib detail-page baru, lihat `memory/preferences/ui/admin-shell-design.md`) plus aksi "Terapkan DP" di `/ar-invoices/[id]`. Keenamnya sudah dihapus dari folder ini per aturan siklus hidup di atas. Item `ar-penggantian-barang-retur.md` sudah **Selesai** — diapply di migration `0026_ar_warranty_replacements.sql` (tabel baru `warranty_replacements`/`warranty_replacement_lines`, RPC `create_warranty_replacement`, reuse `consume_fifo`/`consume_weighted_average`), sudah dihapus dari folder ini. Item `ar-overpayment-saldo-kredit.md` sudah **Selesai** — diapply di migration `0027_ar_customer_credits.sql` + seed `0028_seed_demo_ar_customer_credits.sql` (tabel baru `ar_customer_credits`/`ar_customer_credit_applications`/`ar_customer_credit_refunds`, akun COA baru `2400`, RPC `apply_ar_customer_credit`/`refund_ar_customer_credit`, `record_ar_payment`/`ar_payment_allocations_no_over_allocation`/`ar_deposit_applications_guard`/`create_ar_invoice`/`cancel_ar_invoice` diperluas), sudah dihapus dari folder ini. Kasus retur yang bikin outstanding negatif masih beda & belum di-scope (lihat "Belum Termasuk" di `docs/domain/accounts-receivable.md`). Item `ar-piutang-tak-tertagih.md` sudah **Selesai** — diapply di migration `0029_ar_bad_debt_writeoffs.sql` + seed `0030_seed_demo_ar_bad_debt_writeoffs.sql` (tabel baru `ar_bad_debt_writeoffs`, akun COA baru `5700`, RPC `write_off_ar_invoice`, metode **direct write-off** bukan allowance/provisi — 5 fungsi existing diperluas: `ar_payment_allocations_no_over_allocation`/`ar_deposit_applications_guard`/`ar_customer_credit_applications_guard`/`create_ar_invoice`/`cancel_ar_invoice`), sudah dihapus dari folder ini. UI-nya panel "Hapusbukukan" inline di `/ar-invoices/[id]` (status baru `dihapusbukukan` di `invoiceStatus()`). Recovery piutang yang udah di-write-off masih di luar scope (lihat "Belum Termasuk" di `docs/domain/accounts-receivable.md`).) Item `ap-retur-barang.md` sudah **Selesai** — diapply di migration `0035_ap_credit_notes_schema.sql` + seed `0036_seed_demo_ap_credit_notes.sql` (7 tabel baru: `ap_credit_notes`/`purchase_return_lines`/`purchase_replacements`/`purchase_replacement_lines`/`ap_return_credits`/`ap_return_credit_applications`/`ap_return_credit_refunds`, RPC `create_ap_credit_note`/`create_purchase_replacement`/`apply_ap_return_credit`/`refund_ap_return_credit`, akun COA baru `1350` Piutang Retur Supplier). Beda dari AR: 2 resolusi retur **saling eksklusif** (Opsi A kurangi utang, Opsi B tukar barang berdiri sendiri), bukan additive — proses desainnya justru nemuin cacat di AR `warranty_replacement`, ketauan lewat diskusi ngajarin (2026-08-06, contoh Pak Budi). Sudah dihapus dari folder ini. Item `ar-warranty-replacement-kompensasi-ganda.md` sudah **Selesai** — diapply di migration `0037_ar_warranty_replacement_discount_reversal.sql` (opsi (b): `create_warranty_replacement` sekarang wajib membalikkan diskon retur `create_ar_credit_note` secara proporsional — kolom baru `warranty_replacements.discount_reversed_amount`/`discount_reversal_journal_entry_id`, trigger `warranty_replacements_no_over_reverse`, param RPC baru `p_contra_revenue_account_id`/`p_receivable_account_id`), UI-nya 2 select akun tambahan + kolom "Diskon Retur Dibalik" di panel Penggantian Barang inline `/ar-invoices/[id]`. Sudah dihapus dari folder ini.

---

Update file ini tiap ada folder/file baru ditambahkan ke `/memory`, atau tiap ada scope-debt yang dihapus karena selesai.