# Docs Brief — Entry Point (untuk Kamu)

Peta seluruh `/docs`. Ini adalah knowledge base kamu — media informasi bisnis/akuntansi & jejak pembangunan project, ditulis naratif dan non-teknis. Bahasa program (RPC, trigger, DDL) sengaja dihindari di sini; kalau butuh itu, itu ada di `/memory` (context Claude, bukan buat dibaca manual).

## Struktur

```
/docs
  brief.md               <- file ini
  /domain                 <- knowledge bisnis/akuntansi, naratif, buat belajar
  /architecture
    /data                 <- ERD & struktur data tiap modul, dijelasin non-teknis (tabel, bukan DDL)
  /tutorial                <- user guide operasional per task/workflow ("klik di mana, isi apa")
    /<modul>               <- 1 subfolder per modul (chart-of-accounts, general-ledger, accounts-receivable, dst — lihat isi di bawah), dibangun/diupdate lewat skill `/tutorial`
```

Konvensi penamaan file: kebab-case deskriptif, tanpa prefix nomor. Nama file sama antara `docs/domain/*.md` dan `memory/domain/*.md` (padanan naratif vs compact — lihat `memory/brief.md` kalau butuh versi teknis/RPC/trigger). `docs/tutorial/` beda pola — disegmentasi 2 level (`<modul>/<task>.md`), bukan 1 file per modul kayak `domain`/`architecture`, karena granularity-nya per task/workflow, bukan per modul (lihat `.claude/skills/tutorial/SKILL.md`).

## Docs viewer di web app

Seluruh isi `/docs` direpresentasikan juga di web app-nya sendiri, di routing `/docs` (`apps/erp/src/app/docs/`) — halaman dokumentasi produk biar gak perlu buka file `.md` manual. Baca file langsung dari folder ini lewat `apps/erp/src/lib/docs/fs.ts` (server-side, gak ada duplikasi konten), render markdown (termasuk fence ```mermaid dan cross-reference link relatif antar tutorial) lewat `apps/erp/src/components/docs/`. Gerbang login sama seperti halaman ERP lain (`useRequireAuth`). Kategori `domain`/`architecture` flat (`/docs/<category>/<slug>`); kategori `tutorial` grouped per modul (`/docs/tutorial/<modul>/<slug>`) — daftar kategori mana yang grouped ada di `apps/erp/src/lib/docs/categories.ts` (`isGroupedCategory`), bukan hardcode per halaman.

## Isi saat ini

### domain/
- `chart-of-accounts.md` — 5 kategori akun, normal balance, kenapa expense=debit/revenue=kredit (derivasi dari persamaan akuntansi), struktur hierarkikal (header vs leaf account, rule leaf-only posting), **akun kontra** (definisi, simulasi dengan/tanpa kontra, contoh lintas kategori: Akumulasi Penyusutan/Cadangan Kerugian Piutang/Retur Penjualan), contoh angka, common mistake.
- `general-ledger.md` — Journal Entry vs General Ledger, accrual vs cash basis, constraint wajib (balance, min 2 baris, leaf-only, immutability/reversing entry, source_ref, atomicity), period closing (konsep + kenapa levelnya beda dari immutability), contoh transaksi generik, common mistake.
- `accounts-receivable.md` — customer master data + termin, invoice (due_date snapshot) & payment & payment allocation (many-to-many, kenapa gak cukup invoice_id langsung), status invoice derived, constraint (journal-backed, immutability, anti over-allocation, cancellation guard), 5 skenario alokasi, belum termasuk (retur, DP, overpayment).
- `accounts-payable.md` — kebalikan AR: supplier master data + termin (ditentuin SUPPLIER, bukan kita), bill & payment & payment allocation, constraint identik AR + cancellation guard, 5 skenario (termasuk aging kebalik dari AR), belum termasuk (retur, DP, bill compound).
- `inventory.md` — membeli ≠ berbiaya (matching principle), Weighted Average (satu-satunya metode costing, FIFO sudah dihapus total — migration `0038`), BOM/Production Order (biaya bahan baku doang, belum labor/overhead), PO → GRN+Bill (3-way matching), Goods Issue (titik HPP diakui), belum termasuk (GR/IR clearing, Sales Order, price variance report).
- `fixed-assets.md` — matching by time (beda dari Inventory yang matching by event), 2 metode penyusutan in-scope: garis lurus (SLM) & saldo menurun (declining balance), kenapa kredit penyusutan wajib ke akun Akumulasi Penyusutan terpisah, akun kontra-asset, belum termasuk (disposal, metode Unit Produksi, revaluasi, ganti metode di tengah jalan).
- `financial-reports.md` — read-only agregasi dari jurnal, 4 laporan: Trial Balance, Income Statement, Balance Sheet, Cash Flow. Urutan wajib TB→IS→BS→CF, cara validasi silang. Contoh angka lengkap 1 periode tervalidasi end-to-end. Period Closing (konteks bisnis).
- `document-numbering.md` — cross-cutting, menggantikan field "Rujukan Dokumen" isi-manual dengan nomor otomatis format PREFIX-TAHUN-URUTAN (reset tiap tahun) di semua dokumen transaksional. Kasus khusus AP Bill (dokumen eksternal, nota supplier) — nomor asli direkam terpisah di field "Nomor Nota Supplier".

### architecture/
ERD & struktur data tiap modul, dalam bahasa non-teknis + tabel (bukan DDL mentah, bukan bahas RPC/trigger secara kode):
- `coa-schema.md`, `journal-entry-schema.md`, `ar-schema.md`, `ap-schema.md`, `inventory-schema.md`, `fixed-assets-schema.md`.
- `financial-reports-schema.md` — 4 laporan (Trial Balance/Income Statement/Balance Sheet/Cash Flow) dijelaskan sebagai lapisan baca di atas 3 tabel yang sudah ada (`accounts`, `journal_entries`, `journal_lines`), gak ada tabel baru. Tutup Buku (Period Closing) beda — nambah 1 tabel (`period_closings`), plus aturan urutan-bersambung & gak bisa dibuka lagi. Keterbatasan lain: Cash Flow Direct Method, kategorisasi Investing/Financing otomatis.
- `document-numbering-schema.md` — 2 tabel baru (Daftar Jenis Dokumen, Penghitung Nomor) + 1 kolom baru di AP Bill (Nomor Nota Supplier).
- `default-account-settings-schema.md` — 2 tabel baru (Default Akun, Preset Akun Aset Tetap), mengganti dropdown akun bebas di hampir semua form transaksi dengan field otomatis terkunci — dipicu bug nyata (salah pilih akun di panel Retur AP Bill).

### tutorial/
User guide operasional per task/workflow ("klik di mana, isi apa"), dibangun lewat skill `/tutorial`. Batch 1 (alur harian inti) + Batch 2 (kasus khusus) + Batch 3 (gap: ledger/cetak/refund kredit/master data) sudah dibangun — cakupan modul sudah lengkap. Disegmentasi jadi 10 subfolder modul (42 file total):
- `chart-of-accounts/` — `tambah-akun-baru.md`.
- `general-ledger/` — `buat-jurnal-manual.md`, `lihat-buku-besar-akun.md`.
- `accounts-receivable/` — `tambah-pelanggan-baru.md`, `buat-invoice-ar.md`, `terima-pembayaran-ar.md`, `retur-barang-ar.md`, `tukar-barang-garansi.md`, `uang-muka-ar.md`, `cek-credit-hold-pelanggan.md`, `writeoff-piutang.md`, `batalkan-invoice-ar.md`.
- `accounts-payable/` — `tambah-supplier-baru.md`, `buat-bill-ap.md`, `bayar-bill-ap.md`, `retur-barang-ap.md`, `uang-muka-ap.md`, `batalkan-bill-ap.md`.
- `inventory/` — `tambah-item-master.md`, `atur-satuan-harga-barcode.md`, `kelola-kategori-brand-barang.md`, `buat-purchase-order.md`, `terima-barang-grn.md`, `jual-barang-goods-issue.md`, `buat-resep-bom.md`, `buat-production-order.md`, `buat-sales-order.md`, `kirim-penuhi-sales-order.md`, `stock-opname.md`, `lihat-stock-position.md`.
- `fixed-assets/` — `tambah-aset-tetap.md`, `posting-penyusutan-aset.md`.
- `financial-reports/` — `lihat-laporan-keuangan.md`, `tutup-buku-periode.md`.
- `pos/` — `checkout-pos.md`, `batalkan-transaksi-pos.md`.
- `settings/` — `atur-default-akun.md`, `atur-kategori-biaya-ppn.md`, `atur-kop-surat-cetakan.md` (prasyarat lintas modul — direferensikan dari banyak tutorial modul lain).
- `lintas-modul/` — `cetak-dokumen.md`, `arsipkan-hapus-master-data.md`, `refund-saldo-kredit-retur.md` (task yang genuinely lintas modul, bukan milik 1 modul spesifik).

---

Update file ini tiap ada folder/file baru ditambahkan ke `/docs`.
