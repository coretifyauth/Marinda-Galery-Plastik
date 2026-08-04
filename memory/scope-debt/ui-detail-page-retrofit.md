# UI — Retrofit Detail Page buat Tabel yang Punya Children

**Modul asal:** Cross-module (UI/UX, bukan modul bisnis spesifik). **Status:** Ditunda.

## Kasus

Aturan wajib baru disepakati (`memory/preferences/ui/admin-shell-design.md`, section "Detail Page — ATURAN WAJIB"): tiap tabel yang punya child/related table (1-ke-banyak) **wajib** punya halaman detail `[id]`, dan aksi transaksional apa pun terhadap baris itu (retur, batalkan, terapkan, hanguskan, posting, dst) **wajib hidup di halaman detail itu** — row list jadi murni klik-untuk-navigasi, bukan inline di row.

`/ar-invoices/[id]` dan `/ar-deposits/[id]` sudah sesuai aturan ini (jadi acuan pola implementasi). 9 halaman list lain dibangun **sebelum** aturan ini eksplisit, jadi belum di-retrofit — masih murni tabel row tanpa halaman detail, padahal tabelnya punya children:

- `/journal-entries` (child: `journal_lines`)
- `/ar-payments` (child: `ar_payment_allocations`)
- `/ap-bills`, `/ap-payments` (child: `ap_payment_allocations` dst, mirror AR)
- `/purchase-orders` (child: `purchase_order_lines`)
- `/goods-receipts` (child: `goods_receipt_lines`)
- `/production-orders` (child: `production_order_lines`)
- `/bom` (child: `bom_lines`)
- `/goods-issues` (child: `goods_issue_lines`)

**Catatan terkait, kategori gap beda** (jangan ilang dari radar walau bukan bagian dari 9 di atas): `/fixed-assets/[id]` **sudah** punya halaman detail, tapi aksi "Posting Penyusutan" masih nyangkut inline di row list `/fixed-assets` — belum dipindah ke detail page-nya sendiri. Ini bukan "belum ada detail page", tapi "detail page ada, aksinya belum dipindah ke situ".

## Kenapa ditunda

User eksplisit minta ini dicatat dulu sebagai scope-debt, bukan dikerjakan sekarang — fokus sesi ini cuma retrofit `/ar-deposits/[id]`. Retrofit 9 halaman lain (+ fixed-assets) butuh kerja per-halaman yang gak kecil (bikin `page.tsx`+`view.tsx` baru, mindahin query+aksi dari list ke detail, update sidebar/topbar breadcrumb kalau perlu) — sengaja dipisah per prioritas modul, bukan dikerjain sekaligus dalam satu putaran.

## Kapan perlu digarap

Begitu diminta eksplisit oleh user. Prioritas per modul terserah user pas diminta — gak ada urutan wajib. Pola implementasi & acuan lengkap ada di `memory/preferences/ui/admin-shell-design.md` section "Detail Page — ATURAN WAJIB"; contoh kode acuan: `/ar-invoices/[id]` dan `/ar-deposits/[id]`.

## Referensi

- `memory/preferences/ui/admin-shell-design.md` (section "Detail Page — ATURAN WAJIB") — aturan lengkap + daftar halaman yang belum sesuai
- `src/app/(app)/ar-invoices/[id]/` dan `src/app/(app)/ar-deposits/[id]/` — contoh implementasi yang sudah sesuai aturan
