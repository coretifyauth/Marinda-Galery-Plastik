# Docs Brief — Entry Point (untuk Kamu & Claude)

Peta seluruh `/docs`. Ini adalah SATU-SATUNYA sumber knowledge bisnis/akuntansi & struktur data project — dipakai baik oleh kamu maupun Claude, gak ada lagi salinan compact di `/memory` (dihapus 2026-09-08, lihat `AGENTS.md` > "Docs Structure Overview" buat alasannya). Ditulis naratif dan non-teknis — bahasa program (RPC, trigger, DDL mentah) sengaja dihindari; kalau butuh syntax SQL persis, itu ada di `supabase/migrations/*.sql` (ground truth yang aktif di database, tiap file `docs/architecture/*.md` nunjuk ke migration pasangannya).

`/memory` masih ada, tapi sekarang isinya CUMA konten yang emang gak punya bentuk naratif buat manusia: preferensi kode/UI, mental model wajib sebelum bangun fitur, dan ledger keputusan yang sengaja ditunda (scope-debt/special-case). Lihat `memory/brief.md`.

Gak ada lagi viewer web app buat `/docs` (route `/docs` di `apps/erp` dihapus 2026-09-08) — dibaca langsung sebagai file `.md`.

## Struktur

```
/docs
  brief.md               <- file ini
  /domain                 <- knowledge bisnis/akuntansi, naratif, buat belajar
  /architecture            <- ERD & struktur data tiap tabel spine, dijelasin non-teknis (tabel, bukan DDL)
  /tutorial                <- user guide operasional per task/workflow ("klik di mana, isi apa")
    /<modul>               <- 1 subfolder per modul (chart-of-accounts, general-ledger, accounts-receivable, dst — lihat isi di bawah), dibangun/diupdate lewat skill `/tutorial`
```

Konvensi penamaan file: kebab-case deskriptif, tanpa prefix nomor. `docs/tutorial/` beda pola — disegmentasi 2 level (`<modul>/<task>.md`), bukan 1 file per modul kayak `domain`/`architecture`, karena granularity-nya per task/workflow, bukan per modul (lihat `.claude/skills/tutorial/SKILL.md`).

## Isi saat ini

### domain/
- `chart-of-accounts.md` — 5 kategori akun, normal balance, kenapa expense=debit/revenue=kredit (derivasi dari persamaan akuntansi), struktur hierarkikal (header vs leaf account, rule leaf-only posting), **akun kontra** (definisi, simulasi dengan/tanpa kontra, contoh lintas kategori: Akumulasi Penyusutan/Cadangan Kerugian Piutang/Retur Penjualan), contoh angka, common mistake.
- `general-ledger.md` — Journal Entry vs General Ledger, accrual vs cash basis, constraint wajib (balance, min 2 baris, leaf-only, immutability/reversing entry, source_ref, atomicity), period closing (konsep + kenapa levelnya beda dari immutability), contoh transaksi generik, common mistake.
- `accounts-receivable.md` — customer master data + termin, invoice (due_date snapshot) & payment & payment allocation (many-to-many, kenapa gak cukup invoice_id langsung), status invoice derived, constraint (journal-backed, immutability, anti over-allocation, cancellation guard), 5 skenario alokasi, belum termasuk (retur, DP, overpayment).
- `accounts-payable.md` — kebalikan AR: supplier master data + termin (ditentuin SUPPLIER, bukan kita), bill & payment & payment allocation, constraint identik AR + cancellation guard, 5 skenario (termasuk aging kebalik dari AR), belum termasuk (retur, DP, bill compound).
- `inventory.md` — membeli ≠ berbiaya (matching principle), Weighted Average (satu-satunya metode costing), BOM/Production Order (biaya bahan baku doang, belum labor/overhead), PO → GRN+Bill (3-way matching), Goods Issue (titik HPP diakui), belum termasuk (GR/IR clearing, Sales Order, price variance report).
- `fixed-assets.md` — matching by time (beda dari Inventory yang matching by event), 2 metode penyusutan in-scope: garis lurus (SLM) & saldo menurun (declining balance), kenapa kredit penyusutan wajib ke akun Akumulasi Penyusutan terpisah, akun kontra-asset, disposal aset (jual/buang/hilang + laba-rugi pelepasan), belum termasuk (metode Unit Produksi, revaluasi, ganti metode di tengah jalan).
- `financial-reports.md` — read-only agregasi dari jurnal, 4 laporan: Trial Balance, Income Statement, Balance Sheet, Cash Flow. Urutan wajib TB→IS→BS→CF, cara validasi silang. Contoh angka lengkap 1 periode tervalidasi end-to-end. Period Closing (konteks bisnis).
- `document-numbering.md` — cross-cutting, menggantikan field "Rujukan Dokumen" isi-manual dengan nomor otomatis format PREFIX-TAHUN-URUTAN (reset tiap tahun) di semua dokumen transaksional. Kasus khusus AP Bill (dokumen eksternal, nota supplier) — nomor asli direkam terpisah di field "Nomor Nota Supplier".

### architecture/
ERD & struktur data, dalam bahasa non-teknis + tabel (bukan DDL mentah, bukan bahas RPC/trigger secara kode — buat syntax SQL persis, tiap file nunjuk ke migration pasangannya di `supabase/migrations/`). Spine-based — 1 file `.md` per tabel spine/root yang beneran ada di Supabase, bukan per modul bisnis (tabel yang dipakai bareng lintas modul, mis. transaksi AR & AP, tetap 1 file). Daftar resmi & pengelompokan file: daftar di bawah ini adalah acuannya.

- `journal-entry-schema.md`, `fixed-assets-schema.md`, `financial-reports-schema.md`, `pos-schema.md` — gak berubah, gak kena unifikasi.
- `coa-schema.md` — gak kena unifikasi AR/AP, tapi 2026-09-14 tabel `roles`/`user_roles`/`signup_whitelist` di-rename `app_roles`/`app_user_roles`/`app_user_signup_whitelist` (prefix `app_` buat tabel config/infrastruktur), `signup_whitelist_roles` digabung jadi kolom `role_name`.
- `counterparty-schema.md` — gabungan pelanggan+pemasok jadi `counterparties`.
- `transactions-schema.md` — gabungan invoice AR + bill AP.
- `payments-schema.md` — gabungan pembayaran AR + AP.
- `returns-schema.md` — gabungan nota kredit retur AR + AP (dulu `credit-notes-schema.md`).
- `return-credits-schema.md` — gabungan saldo kredit retur AR + AP.
- `deposits-schema.md` — gabungan uang muka AR + AP.
- `replacements-schema.md` — gabungan ganti barang garansi AR + tukar barang ke pemasok AP (retur Opsi B), 2026-09-09.
- `app-settings-schema.md` (dulu `tax-settings-schema.md`, digabung dengan `company_settings`+`pos_settings` 2026-09-14) — Pengaturan PPN + identitas perusahaan + walk-in customer POS, 1 baris dipakai bareng AR/AP/POS/print.
- `items-schema.md` — master barang, satuan jual/harga, Kode Scan Barang.
- `orders-schema.md` — gabungan Purchase Order + Sales Order.
- `goods-notes-schema.md` (dulu `goods-receipt-schema.md`+`goods-issue-schema.md`, digabung 2026-09-07) — penerimaan barang dari pemasok (3-Way Matching, INBOUND) dan penjualan/keluar barang ke pelanggan (OUTBOUND, titik HPP diakui), 1 tabel generic dibedakan `type`.
- `bom-schema.md` — resep produksi (Bill of Materials).
- `production-orders-schema.md` — order produksi, konsumsi bahan baku jadi barang jadi.
- `stock-opname-schema.md` — penyesuaian stok fisik.
- `inventory-ledger-schema.md` — saldo & kartu stok (Weighted Average Costing).
- `document-numbering-schema.md` — 2 tabel baru (Daftar Jenis Dokumen, Penghitung Nomor) + 1 kolom baru di AP Bill (Nomor Nota Supplier).
- `default-account-settings-schema.md` — 2 tabel baru (Default Akun, Preset Akun Aset Tetap), mengganti dropdown akun bebas di hampir semua form transaksi dengan field otomatis terkunci — dipicu bug nyata (salah pilih akun di panel Retur AP Bill). Tabel `default_account_settings` di-rename `app_default_account_settings` 2026-09-14.
- `print-templates-schema.md` dihapus 2026-09-14 — isinya (`document_signatories`, identitas perusahaan) sudah tuntas dipindah/dihapus: kop surat jadi bagian `app-settings-schema.md`, blok tanda tangan (`document_signatories`) di-drop total (fitur gak dipakai lagi, lihat `docs/domain/print-templates.md`).

### tutorial/
User guide operasional per task/workflow ("klik di mana, isi apa"), dibangun lewat skill `/tutorial` — cakupan modul sudah lengkap. Disegmentasi jadi 10 subfolder modul (40 file total):
- `chart-of-accounts/` — `tambah-akun-baru.md`.
- `general-ledger/` — `buat-jurnal-manual.md`, `lihat-buku-besar-akun.md`.
- `accounts-receivable/` — `tambah-pelanggan-baru.md`, `buat-invoice-ar.md`, `terima-pembayaran-ar.md`, `retur-barang-ar.md`, `tukar-barang-garansi.md`, `uang-muka-ar.md`, `batalkan-invoice-ar.md`.
- `accounts-payable/` — `tambah-supplier-baru.md`, `buat-bill-ap.md`, `bayar-bill-ap.md`, `retur-barang-ap.md`, `uang-muka-ap.md`, `batalkan-bill-ap.md`.
- `inventory/` — `tambah-item-master.md`, `atur-satuan-harga-barcode.md`, `kelola-kategori-brand-barang.md`, `buat-purchase-order.md`, `terima-barang-grn.md`, `jual-barang-goods-issue.md`, `buat-resep-bom.md`, `buat-production-order.md`, `buat-sales-order.md`, `kirim-penuhi-sales-order.md`, `stock-opname.md`, `lihat-stock-position.md`.
- `fixed-assets/` — `tambah-aset-tetap.md`, `posting-penyusutan-aset.md`.
- `financial-reports/` — `lihat-laporan-keuangan.md`, `tutup-buku-periode.md`.
- `pos/` — `checkout-pos.md`, `batalkan-transaksi-pos.md`.
- `settings/` — `atur-default-akun.md`, `atur-kategori-biaya-ppn.md`, `atur-kop-surat-cetakan.md` (prasyarat lintas modul — direferensikan dari banyak tutorial modul lain).
- `lintas-modul/` — `cetak-dokumen.md`, `arsipkan-hapus-master-data.md`, `refund-saldo-kredit-retur.md` (task yang genuinely lintas modul, bukan milik 1 modul spesifik).

---

Update file ini tiap ada folder/file baru ditambahkan ke `/docs`.
