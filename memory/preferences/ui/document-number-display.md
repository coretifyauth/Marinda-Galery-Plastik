# Nomor Dokumen: Tampil di List & di Sebelah Heading Detail

Diputuskan 2026-08-13 (preferensi user). Berlaku ke semua modul yang punya `doc_type` di `document_number_types` (lihat `docs/architecture/document-numbering-schema.md`).

## List Table

Tabel list tiap modul transaksional tetap nampilin `source_ref` sebagai 1 kolom (label header: `Source Ref`) — ini udah konsisten di 13 dari 14 list page. Satu gap yang ditemukan & sudah diperbaiki: `production-orders/page.tsx` gak render kolomnya walau field-nya udah ke-select — sekarang ada, kolom pertama sebelum "Barang Jadi".

Kalau bikin list table modul baru: tambahin kolom `Source Ref` dari awal, jangan nunggu di-tambahin belakangan kayak kasus production-orders.

## Detail Page Heading

Baru — sebelum ini nomor dokumen cuma keliatan di baris "Rujukan Dokumen" dalam `DetailRows` (di bawah heading, gampang kelewat). Sekarang nomor juga tampil langsung di sebelah kanan judul `<h1>...Details</h1>`, sebagai badge kecil.

**Pola:**
```tsx
<div className="flex items-center justify-between">
  <div className="flex items-center gap-3">
    <h1 className="text-xl font-semibold text-black">{Modul} Details</h1>
    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
      {record.source_ref}
    </span>
  </div>
  {/* tombol aksi (Batalkan, dst) tetap di sini kalau ada -- justify-between yang dorong ke kanan jauh */}
</div>
```
`DetailRows` yang udah nampilin "Rujukan Dokumen"/"Source Ref" di bawah heading TIDAK dihapus — badge ini nambahin visibility, bukan gantiin.

Diterapkan ke 12 detail page yang punya `source_ref` sendiri: `ap-bills`, `ar-invoices`, `purchase-orders`, `sales-orders`, `ap-deposits`, `ar-deposits`, `stock-opnames`, `production-orders`, `journal-entries`, `goods-issues`, `pos-sales` (semua di `apps/erp/src/app/(app)/`).

**Kasus khusus — `goods-receipts/[id]/view.tsx`:** `goods_notes` (`type='INBOUND'`, dulu tabel terpisah `goods_receipt_notes`, digabung migration `0080`-`0083`) gak punya `doc_type`/`source_ref` sendiri (bukan salah satu dari 29 jenis dokumen, lihat schema doc — cuma sisi `OUTBOUND` yang punya `source_ref`, `goods-notes-schema.md`). Badge-nya nampilin nomor AP Bill yang dibuat bareng GRN itu (`grn.ap_bills.source_ref`), dikasih `title` attribute penjelas kenapa nomornya "APB-..." bukan format GRN sendiri.

**Dikecualikan (gak dikasih badge):** `fixed-assets/[id]/view.tsx` — fixed asset itu master data, bukan salah satu dari 29 `doc_type`. Nomor `DEPR-...` untuk depresiasi ada di `journal_entries.source_ref` per postingan, bukan di record fixed asset itu sendiri — nampilinnya butuh join per baris riwayat depresiasi, bukan 1 badge di heading.

## POS Terminal (checkout, bukan list/detail page)

`apps/pos/src/app/page.tsx` — pesan sukses setelah checkout sekarang nyebut nomor transaksinya (`Transaksi berhasil ({sourceRef}) — total Rp...`), sebelumnya cuma nampilin total tanpa nomor sama sekali. Bukan halaman list/detail, tapi titik paling penting buat kasir liat nomor strukanya.

## Referensi

`docs/architecture/document-numbering-schema.md` submodule "Data Lama — Gak Dibackfill" — data lama (pre-`0011_document_numbering.sql`) tetap nampilin `source_ref` manual lama di kedua lokasi ini (list & badge), gak ada indikator visual pembeda dari dokumen baru yang bernomor resmi. Kalau suatu saat mau dibedain visualnya (misal badge abu-abu utk dokumen lama vs badge biru utk yang bernomor resmi), itu belum diputuskan.
