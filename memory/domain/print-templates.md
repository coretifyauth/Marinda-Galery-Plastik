# Cetak Dokumen Fisik — AI Context

Cross-cutting concern, murni **layer presentasi** — gak ada tabel/RPC baru, gak ada migration. Tiap tombol "Cetak" render langsung dari state yang sudah dimuat halaman detail (query yang sama yang sudah dipakai buat nampilin halaman itu), lalu buka window baru + `window.print()`.

Naratif lengkap + reasoning penuh: `docs/domain/print-templates.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu.

## Konsep Inti

- **Gak ada `docs/architecture/print-templates-schema.md` / `memory/architecture/data/print-templates-schema.md`** — gak ada ERD baru buat fitur ini, jadi gak ada padanan schema doc. Detail teknis cukup di sini + komentar kode.
- Helper bersama: `apps/erp/src/lib/print/print-window.ts` — `escapeHtml()` (escape manual, `document.write()` gak auto-escape kayak JSX) + `openPrintWindow(title, bodyHtml)` (`window.open("", "_blank", ...)` + `document.write()` + `window.onload = window.print()`). Pola window terpisah (bukan `@media print`) sama persis yang dipakai label barcode `item_units` (`apps/erp/src/app/(app)/items/[id]/view.tsx`) — native `<dialog>`/Modal gak konsisten diprint lintas browser.

## Live Data, Bukan Snapshot Beku

**Cara Kerja**
- `handlePrint()` di tiap halaman detail baca langsung dari state React yang sudah ada (`invoice`, `po`, dst — hasil `load()` yang sama yang render halaman itu), bukan query terpisah dan bukan hasil generate yang disimpan ke tabel manapun.
- Konsekuensi: reprint kapan pun otomatis dapat kondisi terkini (outstanding, status, qty diterima) — gak ada gap sinkronisasi antara kertas dan database.

**Aturan Bisnis**
- Status non-normal wajib ditampilkan eksplisit di cetakan. AR Invoice: `status === "dibatalkan"` atau `"dihapusbukukan"` (dari `invoiceStatus()`, `lib/ar-invoices/schema.ts`) munculkan banner `.watermark` merah di atas cetakan.
- PO gak punya status pembatalan (`poStatus()` cuma `OPEN`/`PARTIALLY_RECEIVED`/`FULLY_RECEIVED`) — gak ada watermark di cetakan PO.

**Referensi:** `docs/domain/print-templates.md` submodule "Live Data, Bukan Snapshot Beku".

## Aturan Tampilan (berlaku di semua cetakan, cek tiap tambah cetakan baru)

**Cara Kerja**
- **Harga per item wajib** kalau data sumbernya punya harga per unit (PO `unit_cost_expected`, GRN `goods_receipt_lines.unit_cost`, SO `sales_order_lines.unit_price`) — jangan cuma qty.
- **Baris ringkasan relasi (bukan field inti dokumen) disembunyikan kalau nilainya 0** — threshold sama yang dipakai di seluruh codebase buat perbandingan floating amount, `> 0.005` (bukan `!== 0`, konsisten sama `outstanding > 0.005` dkk di `invoiceStatus()`).

**Implementasi AR Invoice** (`ar-invoices/[id]/view.tsx`, `handlePrint()`)
- `GoodsIssueForInvoice` (`lib/ar-credit-notes/schema.ts`) diperluas: `goods_issue_lines` sekarang ikut select `so_line_id` + join `sales_order_lines(unit_price)`. `hasItemPrice = goods_issue_lines.some(l => l.sales_order_lines)` — kalau ada minimal 1 baris yang lahir dari SO, tabel item dapat kolom Harga/Unit + Subtotal (baris tanpa harga isi `-`); kalau gak ada satupun, tabel tetap Barang+Qty aja (perilaku lama).
- `summaryRows` di-filter: `allocated`/`depositApplied`/`returned`/`writtenOff` masing-masing cuma masuk array kalau `> 0.005`. `invoice.amount` (Jumlah Invoice) dan `outstanding` SELALU tampil — dua-duanya field inti invoice itu sendiri, bukan agregat dari tabel relasi.

**Implementasi PO** (`purchase-orders/[id]/view.tsx`, `handlePrint()`)
- Sudah patuh aturan harga sejak awal (`purchase_order_lines.unit_cost_expected` selalu ada). Gak ada baris ringkasan relasi apa pun di cetakan PO saat ini, jadi aturan sembunyikan-kalau-nol belum relevan di sini — dicek ulang kalau nanti PO print diperluas (misal nambah info status GRN).

**Referensi:** `docs/domain/print-templates.md` submodule "Aturan Tampilan (berlaku di semua cetakan)".

## Cakupan Dokumen (Fase 1)

**Entitas & implementasi**
- **AR Invoice** (`apps/erp/src/app/(app)/ar-invoices/[id]/view.tsx`, `handlePrint()`): header (source_ref, customer, tanggal, jatuh tempo, deskripsi) + tabel item (dari `goodsIssue.goods_issue_lines`, cuma tampil kalau invoice-nya "Full" — financial-only invoice nampilin catatan teks aja) + ringkasan (amount/allocated/depositApplied/returned/writtenOff/outstanding, sama persis angka yang dipakai `<DetailRows>` di halaman itu).
- **Purchase Order** (`apps/erp/src/app/(app)/purchase-orders/[id]/view.tsx`, `handlePrint()`): header (source_ref, supplier, tanggal PO, estimasi tiba) + tabel `purchase_order_lines` (nama item, qty_ordered, unit_cost_expected, subtotal dihitung client-side) + total.
- Tombol "Cetak" (`variant="toolbar"`) di header halaman detail, sejajar tombol aksi entity lain (pola sama `admin-shell-design.md` — aksi scope-entity di header, bukan di tab).

**Belum dicakup (sengaja, bukan bug)**
- Kop surat (nama perusahaan/alamat/logo) dan blok tanda tangan — `memory/scope-debt/print-template-letterhead-signature.md`.
- Dokumen lain (AP Bill, Goods Receipt, Goods Issue, dst) — pola implementasinya identik (reuse `print-window.ts`), tambah kalau ada kebutuhan nyata.

**Referensi:** `docs/domain/print-templates.md` submodule "Cakupan Dokumen (Fase 1)".
