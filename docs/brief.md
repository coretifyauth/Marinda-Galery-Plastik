# Docs Brief — Entry Point (untuk Kamu)

Peta seluruh `/docs`. Ini adalah knowledge base kamu — media informasi bisnis/akuntansi & jejak pembangunan project, ditulis naratif dan non-teknis. Bahasa program (RPC, trigger, DDL) sengaja dihindari di sini; kalau butuh itu, itu ada di `/memory` (context Claude, bukan buat dibaca manual).

## Struktur

```
/docs
  brief.md               <- file ini
  /domain                 <- knowledge bisnis/akuntansi, naratif, buat belajar
  /architecture
    /data                 <- ERD & struktur data tiap modul, dijelasin non-teknis (tabel, bukan DDL)
  /story                  <- skenario bisnis riil (1 perusahaan fiktif, Toko Plastik Makmur Jaya), dipakai berkelanjutan lintas fase roadmap
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
- `fixed-assets.md` — matching by time (beda dari Inventory yang matching by event), 2 metode penyusutan in-scope: garis lurus (SLM) & saldo menurun (declining balance), kenapa kredit penyusutan wajib ke akun Akumulasi Penyusutan terpisah, akun kontra-asset, belum termasuk (disposal, metode Unit Produksi, revaluasi, ganti metode di tengah jalan).
- `financial-reports.md` — read-only agregasi dari jurnal, 4 laporan: Trial Balance, Income Statement, Balance Sheet, Cash Flow. Urutan wajib TB→IS→BS→CF, cara validasi silang. Contoh angka lengkap 1 periode tervalidasi end-to-end. Period Closing (konteks bisnis).
- `document-numbering.md` — cross-cutting, menggantikan field "Rujukan Dokumen" isi-manual dengan nomor otomatis format PREFIX-TAHUN-URUTAN (reset tiap tahun) di semua dokumen transaksional. Kasus khusus AP Bill (dokumen eksternal, nota supplier) — nomor asli direkam terpisah di field "Nomor Nota Supplier".

### architecture/
ERD & struktur data tiap modul, dalam bahasa non-teknis + tabel (bukan DDL mentah, bukan bahas RPC/trigger secara kode):
- `coa-schema.md`, `journal-entry-schema.md`, `ar-schema.md`, `ap-schema.md`, `inventory-schema.md`, `fixed-assets-schema.md`.
- `financial-reports-schema.md` — 4 laporan (Trial Balance/Income Statement/Balance Sheet/Cash Flow) dijelaskan sebagai lapisan baca di atas 3 tabel yang sudah ada (`accounts`, `journal_entries`, `journal_lines`), gak ada tabel baru. Tutup Buku (Period Closing) beda — nambah 1 tabel (`period_closings`), plus aturan urutan-bersambung & gak bisa dibuka lagi. Keterbatasan lain: Cash Flow Direct Method, kategorisasi Investing/Financing otomatis.
- `document-numbering-schema.md` — 2 tabel baru (Daftar Jenis Dokumen, Penghitung Nomor) + 1 kolom baru di AP Bill (Nomor Nota Supplier).
- `default-account-settings-schema.md` — 2 tabel baru (Default Akun, Preset Akun Aset Tetap), mengganti dropdown akun bebas di hampir semua form transaksi dengan field otomatis terkunci — dipicu bug nyata (salah pilih akun di panel Retur AP Bill).

### story/
Semua file di bawah — kecuali `company-profile.md` — ditulis sebagai **tutorial klik-per-klik di UI beneran** (menu sidebar, field, tombol, hasil yang harus muncul), bukan cuma cerita di atas kertas. Satu bisnis fiktif dipakai konsisten lintas file: **Toko Plastik Makmur Jaya**.
- `company-profile.md` — profil bisnis Toko Plastik Makmur Jaya (retail + grosir perlengkapan plastik, Surabaya, dirintis Pak Herman 2019), pemain: `admin` Pak Herman & kasir `cashier` Mbak Rina (POS-only), 3 pelanggan grosir (Toko Kelontong Sumber Rejeki/Warung Bu Siti/Toko Serba Ada Barokah), 2 supplier (PT Plastindo Jaya/CV Sumber Plastik), 8 item termasuk barang rakitan BOM (Paket Alat Makan), 2 aset tetap (Mobil Pickup Antar Barang/Rak Display Toko) — konteks & motivasi dipakai berulang tiap fase roadmap.
- `chart-of-accounts.md` — COA nyata Pak Herman (Kas header + Kas Toko/Kas di Bank, Pendapatan Penjualan Toko vs Grosir dipisah, dst) + tutorial `/accounts`: filter kategori, tambah akun leaf/child (normal_balance derived otomatis), published-lock banner, tab Ledger, leaf-only posting, kenapa `is_contra` gak ada di form create.
- `general-ledger.md` — 6 transaksi Agustus 2026 (setoran modal, jual retail tunai, kirim ke Sumber Rejeki net-30, beli stok dari Plastindo Jaya, gaji Mbak Rina, cicilan mobil pickup 3-baris compound), tutorial input manual `/journal-entries` (indikator balance, compound baris) + `/general-ledger` standalone, saldo akhir Kas di Bank Rp10.800.000. Gap dicatat: RPC reversal ada tapi tombol trigger di UI belum ada (tampilan badge reversal sudah jalan).
- `accounts-receivable.md` — 3 customer grosir (Sumber Rejeki/Bu Siti/Serba Ada Barokah), 10 skenario: invoice kompunding + PPN Keluaran, payment cicilan + anti-overpay, aging & credit hold, retur jalur full (kondisi Layak Jual/Rusak) + penggantian barang garansi, retur financial-only → AR Return Credit + refund tunai, write-off piutang tak tertagih, DP diterima (diterapkan penuh, atau hangus), invoice dibatalkan.
- `accounts-payable.md` — mirror AR dari sisi utang: 2 supplier (Plastindo Jaya net-30/Sumber Plastik net-21), bill kompunding + PPN Masukan, payment cicilan (1 bill per payment), aging kebalik (kita yang telat), retur Opsi A (kurangi utang)/Opsi B (tukar barang)/Opsi C (tulis-jadi-beban), AP Return Credit refund tunai, DP dibayar (diselesaikan campuran: terapkan + refund + hangus), bill dibatalkan.
- `inventory.md` — timeline Agustus–September 2026, 8 item (7 RAW_MATERIAL dari Plastindo Jaya/Sumber Plastik + 1 FINISHED_GOOD rakitan "Paket Alat Makan"), semuanya Weighted Average, alur PO→GRN (termasuk kenaikan harga & recalculation avg cost), BOM 3 bahan, 2 Production Order, Sales Order fulfillment bertahap ke Serba Ada Barokah, Goods Issue multi-unit ke Bu Siti, Stock Opname (3 item selisih, jurnal per baris gak di-netting). Posisi akhir per 10 September 2026 ≈ Rp2.820.550.
- `fixed-assets.md` — akuisisi 2023–2024: Mobil Pickup Antar Barang (declining balance 35%/tahun, 2x posting tahunan) + Rak Display Toko (straight-line, 12x posting bulanan), pakai ulang akun kontra warisan skenario lama karena form Chart of Accounts gak ada toggle `is_contra`, plus uji coba trigger proteksi cap penyusutan. Posisi akhir per 31 Desember 2025: nilai buku total Rp88.050.000.
- `document-numbering.md` — walkthrough AP Bill dari PT Plastindo Jaya (nomor internal `APB-2026-00007` + Nomor Nota Supplier `SP-0451` terpisah) dan AR Invoice ke Toko Kelontong Sumber Rejeki (cuma 1 nomor, `ARI-2026-00012`), plus contoh reset tahunan.
- `financial-reports.md` — walkthrough UI 4 laporan read-only (Trial Balance/Income Statement/Balance Sheet/Cash Flow) + Tutup Buku (satu-satunya yang menulis), skenario latihan 7 transaksi Jan–Agu 2026 (beli Mobil Pickup via Utang Bank, restock dari Plastindo Jaya, penjualan retail POS + grosir Bu Siti, HPP, gaji Mbak Rina, penyusutan mobil pickup, cicilan utang) — TB=IS=BS=CF tervalidasi (total 34.250.000, Laba Bersih 4.250.000). Tutup Buku periode Jan–Agu 2026, plus gap yang sudah dibenerin: Income Statement re-query periode tertutup exclude baris closing entry sendiri, TB/BS sengaja gak exclude.
- `pos.md` — 2 app terpisah (`apps/pos` kios kasir Mbak Rina, `apps/erp` admin Pak Herman), walkthrough checkout tunai & QRIS retail, setup Kategori Biaya Tambahan (Biaya Packing) + PPN di `/settings/charges`, checkout borongan Toko Serba Ada Barokah dengan biaya tambahan+PPN dalam 1 transaksi, checkout ditolak karena stok gak cukup (no-oversell client + server), riwayat `/pos-sales` + detail + Batalkan (`void_pos_sale` membalik jurnal & stok).

---

Update file ini tiap ada folder/file baru ditambahkan ke `/docs`.
