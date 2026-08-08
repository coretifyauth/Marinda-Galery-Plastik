# Docs Brief — Entry Point (untuk Kamu)

Peta seluruh `/docs`. Ini adalah knowledge base kamu — media informasi bisnis/akuntansi & jejak pembangunan project, ditulis naratif dan non-teknis. Bahasa program (RPC, trigger, DDL) sengaja dihindari di sini; kalau butuh itu, itu ada di `/memory` (context Claude, bukan buat dibaca manual).

## Struktur

```
/docs
  brief.md               <- file ini
  /domain                 <- knowledge bisnis/akuntansi, naratif, buat belajar
  /architecture
    /data                 <- ERD & struktur data tiap modul, dijelasin non-teknis (tabel, bukan DDL)
  /story                  <- skenario bisnis riil (1 perusahaan fiktif, CV Roti Barokah), dipakai berkelanjutan lintas fase roadmap
```

Konvensi penamaan file: kebab-case deskriptif, tanpa prefix nomor. Nama file sama antara `docs/domain/*.md` dan `memory/domain/*.md` (padanan naratif vs compact — lihat `memory/brief.md` kalau butuh versi teknis/RPC/trigger).

## Docs viewer di web app

Seluruh isi `/docs` direpresentasikan juga di web app-nya sendiri, di routing `/docs` (`src/app/docs/`) — halaman dokumentasi produk biar gak perlu buka file `.md` manual. Baca file langsung dari folder ini lewat `src/lib/docs/fs.ts` (server-side, gak ada duplikasi konten), render markdown (termasuk fence ```mermaid) lewat `src/components/docs/`. Gerbang login sama seperti halaman ERP lain (`useRequireAuth`).

## Isi saat ini

### domain/
- `chart-of-accounts.md` — 5 kategori akun, normal balance, kenapa expense=debit/revenue=kredit (derivasi dari persamaan akuntansi), struktur hierarkikal (header vs leaf account, rule leaf-only posting), **akun kontra** (definisi, simulasi dengan/tanpa kontra, contoh lintas kategori: Akumulasi Penyusutan/Cadangan Kerugian Piutang/Retur Penjualan), contoh angka, common mistake.
- `general-ledger.md` — Journal Entry vs General Ledger, accrual vs cash basis, constraint wajib (balance, min 2 baris, leaf-only, immutability/reversing entry, source_ref, atomicity), period closing (konsep + kenapa levelnya beda dari immutability), contoh transaksi generik, common mistake.
- `accounts-receivable.md` — customer master data + termin, invoice (due_date snapshot) & payment & payment allocation (many-to-many, kenapa gak cukup invoice_id langsung), status invoice derived, constraint (journal-backed, immutability, anti over-allocation, cancellation guard), 5 skenario alokasi, belum termasuk (retur, DP, overpayment).
- `accounts-payable.md` — kebalikan AR: supplier master data + termin (ditentuin SUPPLIER, bukan kita), bill & payment & payment allocation, constraint identik AR + cancellation guard, 5 skenario (termasuk aging kebalik dari AR), belum termasuk (retur, DP, bill compound).
- `inventory.md` — membeli ≠ berbiaya (matching principle), Weighted Average (satu-satunya metode costing, FIFO sudah dihapus total — migration `0038`), BOM/Production Order (biaya bahan baku doang, belum labor/overhead), PO → GRN+Bill (3-way matching), Goods Issue (titik HPP diakui), belum termasuk (GR/IR clearing, Sales Order, price variance report).
- `fixed-assets.md` — matching by time (beda dari Inventory yang matching by event), 2 metode penyusutan in-scope: garis lurus (SLM) & saldo menurun (declining balance), kenapa kredit penyusutan wajib ke akun Akumulasi Penyusutan terpisah, akun kontra-asset, contoh angka oven Rp15jt/5th (SLM) & motor Rp24jt/40% (declining balance), belum termasuk (disposal, metode Unit Produksi, revaluasi, ganti metode di tengah jalan).
- `financial-reports.md` — read-only agregasi dari jurnal, 4 laporan: Trial Balance, Income Statement, Balance Sheet, Cash Flow. Urutan wajib TB→IS→BS→CF, cara validasi silang. Contoh angka lengkap 1 periode tervalidasi end-to-end. Period Closing (konteks bisnis).

### architecture/
ERD & struktur data tiap modul, dalam bahasa non-teknis + tabel (bukan DDL mentah, bukan bahas RPC/trigger secara kode):
- `coa-schema.md`, `journal-entry-schema.md`, `ar-schema.md`, `ap-schema.md`, `inventory-schema.md`, `fixed-assets-schema.md`.
- `financial-reports-schema.md` — 4 laporan (Trial Balance/Income Statement/Balance Sheet/Cash Flow) dijelaskan sebagai lapisan baca di atas 3 tabel yang sudah ada (`accounts`, `journal_entries`, `journal_lines`), gak ada tabel baru. Tutup Buku (Period Closing) beda — nambah 1 tabel (`period_closings`), plus aturan urutan-bersambung & gak bisa dibuka lagi. Keterbatasan lain: Cash Flow Direct Method, kategorisasi Investing/Financing otomatis.

### story/
- `company-profile.md` — profil bisnis CV Roti Barokah (UMKM roti, Bandung), konteks & motivasi yang dipakai berulang tiap fase roadmap.
- `chart-of-accounts.md` — COA nyata Bu Nur + guide simulasi interface (Supabase Studio + curl REST).
- `general-ledger.md` — 6 transaksi Juli 2026, tabel General Ledger `Kas di Bank` sebagai contoh, guide simulasi lewat `/journal-entries` + `/general-ledger`.
- `accounts-receivable.md` — 3 customer (Warung Pak Budi/Bu Imas/Kang Ade, termin beda-beda), 3 skenario (lunas tepat waktu, cicil, telat bayar/aging), tabel saldo Piutang Usaha per 30 Juli 2026.
- `accounts-payable.md` — 2 supplier (Toko Tepung Makmur net-14, Toko Gula Sejahtera net-7), 5 skenario (lunas, cicil, bayar gabungan, telat/aging, bill dibatalkan), tabel saldo Utang Usaha per 30 Juli 2026.
- `inventory.md` — Agustus 2026, item Tepung Terigu + Gula Pasir + Roti Tawar (barang jadi), semuanya Weighted Average, alur PO→GRN+Bill, 1 production order, 1 goods issue (jual 30 roti, HPP Rp39.000, laba kotor Rp21.000). Tabel posisi akhir persediaan per 25 Agustus 2026.
- `fixed-assets.md` — akuisisi Januari 2025, Oven Tambahan (straight-line, 12x posting bulanan) + Motor Antar (declining balance 40%/tahun, 1x posting tahunan). Posisi akhir per 31 Desember 2025.
- `financial-reports.md` — pertama kalinya story menggabungkan seluruh fase 1-6 jadi 1 set laporan, angka riil (bukan ilustrasi) hasil agregasi seed data lintas migration. Bagian 1-4: snapshot SEBELUM tutup buku per 25 Agustus 2026, tervalidasi konsisten (TB 66.110.000, BS 38.721.000, CF reconcile 7.180.000), Laba Bersih kumulatif minus (dijelaskan kenapa). Bagian 5: tutup buku SUNGGUHAN (`0017_seed_demo_period_closing.sql`) — 2025 rugi 12.600.000 (wajar, tahun investasi) + Jan-Agu 2026 untung 971.000 (operasional sehat), totalnya sama persis. Juga nemuin & benerin gap: Income Statement sempat gak bisa di-re-query buat periode yang udah ditutup (closing entry-nya sendiri ikut kehitung), sekarang di-exclude otomatis. (Angka HPP/laba direvisi 2026-08-07 pas FIFO dihapus total dari sistem, migration `0038` — HPP Roti Tawar naik dari Weighted Average, angka lama di git history.)

---

Update file ini tiap ada folder/file baru ditambahkan ke `/docs`.
