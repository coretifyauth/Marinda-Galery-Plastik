# Document Numbering — AI Context

Cross-cutting concern, bukan bagian dari 1 modul tunggal — menggantikan field `source_ref` isi-manual di **semua** tabel transaksional (29 jenis dokumen, lihat `memory/architecture/data/document-numbering-schema.md`) dengan nomor auto-generate format `PREFIX-TAHUN-URUTAN`, reset per tahun per jenis dokumen.

Naratif lengkap + reasoning penuh: `docs/domain/document-numbering.md`. Struktur module → submodule di file ini SAMA urutannya dengan padanan naratif itu dan dengan `memory/architecture/data/document-numbering-schema.md`.

## Konsep Inti

**Entitas**
- **document_number_types** — master 29 jenis dokumen + prefix-nya, 1 baris per tabel transaksional yang punya `source_ref`.
- **document_number_counters** — counter urutan per `(doc_type, year)`, sumber nomor berikutnya.
- Fungsi `generate_document_number(p_doc_type text) returns text` — atomic upsert counter, format hasil `{prefix}-{tahun}-{lpad(urutan,5,'0')}`.

**Constraints**
- Uniqueness & no-gap-within-year dijaga primary key `(doc_type, year)` di counter + increment atomik (upsert `on conflict do update`) — gak ada race condition kalau 2 transaksi jalan bersamaan.
- Reset tahunan otomatis: baris counter baru per tahun dibuat lazy (`insert ... on conflict`) begitu tahun itu pertama kali butuh nomor, bukan di-precompute.

## Dokumen Internal vs Dokumen Eksternal

**Cara Kerja**
- 28 dari 29 jenis dokumen: kita yang menerbitkan, nomor otomatis langsung jadi identitas resminya.
- `ap_bills` — representasi nota supplier (dokumen eksternal). Tetap dapat `source_ref` otomatis (`APB-...`), TAPI nomor asli dari nota fisik supplier direkam di kolom baru **`ap_bills.supplier_document_ref`** (text, nullable, isi manual — bukan divalidasi format apa pun karena tiap supplier beda gaya penomoran).

**Aturan Bisnis**
- `create_ap_bill` dapat 1 parameter baru opsional `p_supplier_document_ref text default null`, disimpan apa adanya ke kolom baru. Gak ada validasi uniqueness ke kolom ini (nota dari supplier beda bisa aja punya format/nomor yang kebetulan sama, itu bukan tanggung jawab sistem kita untuk mencegah).

**Referensi:** `memory/architecture/data/document-numbering-schema.md` submodule "AP Bill — Nomor Nota Supplier".

## Kapan Nomor Ditentukan

**Cara Kerja**
- Frontend memanggil `generate_document_number(doc_type)` **persis saat submit** (bukan saat modal dibuka), lalu hasil string-nya dipakai sebagai `p_source_ref` ke RPC create yang sudah ada — 2 RPC call berurutan dalam 1 submit handler, bukan 1 transaksi SQL gabungan.
- **Sengaja gak digabung jadi 1 transaksi** dengan RPC create — supaya gak perlu ubah signature 28 RPC yang sudah ada (`create_ap_bill`, `record_ap_payment`, `create_purchase_order`, dst semuanya TETAP terima `p_source_ref` seperti sekarang, cuma isinya sekarang dari `generate_document_number()` bukan input user).
- Konsekuensi: kalau call generate sukses tapi call create gagal (network putus, validasi RPC gagal, dst), nomor itu sudah kepakai (counter naik) tapi gak pernah muncul di data — gap yang disengaja, diterima karena nomor ini bukan Faktur Pajak resmi.

**Referensi:** `memory/architecture/data/document-numbering-schema.md`.

## Data Lama (Sebelum Sistem Ini Ada)

**Cara Kerja**
- Baris `source_ref` yang sudah ada SEBELUM migration `0011_document_numbering.sql` masih isi manual lama (bukan format `PREFIX-TAHUN-URUTAN`) — gak pernah diubah ke format baru.

**Aturan Bisnis**
- Ditolak: opsi backfill data lama (2026-08-13) — lihat `memory/architecture/data/document-numbering-schema.md` submodule "Data Lama — Gak Dibackfill" untuk alasan teknis (trigger `block_edit_delete` ada di SEMUA tabel transaksional, bukan cuma `journal_entries`, nolak `UPDATE`/`DELETE` tanpa syarat).
- Konsekuensi: dokumen lama (pre-0011) permanen pakai `source_ref` manual lama. Cuma dokumen baru (post-0011) yang bernomor `PREFIX-TAHUN-URUTAN`.

**Referensi:** `memory/architecture/data/document-numbering-schema.md` submodule "Data Lama — Gak Dibackfill", `memory/preferences/ui/document-number-display.md`.

## Glossary

- **doc_type**: kunci di `document_number_types`/`document_number_counters`, sama persis dengan nama tabel transaksionalnya (`ap_bills`, `ar_invoices`, dst) — lihat tabel lengkap 29 jenis di schema doc.
- **supplier_document_ref**: kolom baru `ap_bills`, nomor nota asli dari supplier — terpisah dari `source_ref` yang sekarang otomatis.

Naratif lengkap + reasoning penuh: `docs/domain/document-numbering.md`.
