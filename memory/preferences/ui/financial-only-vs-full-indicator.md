# Retur AP/AR: Badge Financial-Only vs Full, Tab Disaring Sesuai

Diputuskan 2026-08-13 (preferensi user), diterapkan di `ap-bills/[id]/view.tsx` dan `ar-invoices/[id]/view.tsx`. Konteks bisnis lengkap: `memory/domain/accounts-payable.md` & `memory/domain/accounts-receivable.md` submodule "Retur Barang ke Supplier"/"Retur Barang dari Customer".

## Kenapa

Sebagian bill/invoice gak punya barang fisik tercatat (debit langsung ke akun Beban, bukan lewat PO→Goods Receipt / gak ada Goods Issue) — buat dokumen kayak gitu, opsi retur yang butuh qty fisik (Tukar Barang, Tulis-jadi-Beban di AP; Penggantian Barang/Garansi di AR) **selalu ketolak RPC** (`raise exception 'Bill % gak punya goods_receipt_notes...'` dst) kalau dipaksa dicoba. Sebelum ini, tab-nya tetap tampil apa adanya — user baru tau gak bisa dipakai setelah submit gagal. Sekarang gak ditampilin sama sekali kalau emang gak mungkin dipakai.

## Definisi "Financial-Only" vs "Full"

Per dokumen (bukan per baris retur), dari ada-gaknya record fisik yang udah di-fetch di view:
- **AP** (`ap-bills/[id]/view.tsx`): `isFinancialOnly = !goodsReceipt` (state `goodsReceipt`, dari query `goods_receipt_notes` yang match `bill_id`).
- **AR** (`ar-invoices/[id]/view.tsx`): `isFinancialOnly = !goodsIssue` (state `goodsIssue`, dari query `goods_issues` yang match `invoice_id`).

## Badge di Heading

Ditaruh di baris yang sama dengan badge nomor dokumen (`memory/preferences/ui/document-number-display.md`), bukan baris terpisah:

```tsx
<span
  className={`rounded-full px-2.5 py-1 text-sm font-medium ${
    isFinancialOnly ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
  }`}
  title={isFinancialOnly ? "Gak ada goods_receipt_notes -- ..." : "Ada goods_receipt_notes -- ..."}
>
  {isFinancialOnly ? "Financial-Only" : "Full — Barang Fisik"}
</span>
```
Warna: `amber-50/amber-700` buat financial-only ("orange" preferensi user — codebase ini gak punya token `orange-*` terpisah, `amber` udah jadi konvensi warning/partial di tempat lain, mis. `statusStyle.sebagian` di `ap-bills/page.tsx`), `emerald-50/emerald-700` buat full (konsisten sama `statusStyle.lunas`).

## Tab yang Disaring

Tab disaring lewat conditional spread di array `tabs: TabDef[]`, BUKAN disembunyiin via CSS — supaya `activeTab` gak pernah bisa ke-set ke tab yang gak valid buat dokumen itu (user gak bisa klik tab yang gak dirender).

**AP** — disembunyiin kalau `isFinancialOnly`: `tukar` (Tukar Barang). **Tetap tampil**: `jurnal`, `pembayaran`, `dp`, `retur` (Kurangi Utang — satu-satunya opsi retur AP yang punya jalur financial-only, lihat percakapan yang jelasin `create_ap_return`, dulu `create_ap_credit_note`). Tab `writeoff` (Tulis-jadi-Beban, Opsi C) **dicabut total** migration `0068` (2026-09-05) — barang rusak tanpa kompensasi sekarang lewat Stock Opname generic, di luar halaman detail bill ini sama sekali.

**AR** — disembunyiin kalau `isFinancialOnly`: `replacements` (Penggantian Barang/Garansi). **Tetap tampil**: `jurnal`, `pembayaran`, `dp`, `retur`. Tab `writeoff` (Piutang Tak Tertagih) **dicabut total** migration `0064`+`0065` (2026-09-05) bareng penggabungan `ar_invoices`+`ap_bills` jadi `transactions`.

## Kalau nambah modul baru dengan pola serupa

Cek per-opsi retur: apakah RPC-nya punya guard keras (`raise exception` kalau `p_lines`/qty kosong ATAU record fisik gak ada)? Kalau ya → tab itu ikut disaring pola ini. Kalau opsi-nya independen dari fisik → jangan ikut disaring, cek dulu isi RPC-nya sebelum asal nyamain ke modul lain.
