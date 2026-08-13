# Kop Surat & Blok Tanda Tangan di Cetak Dokumen

**Modul asal:** Cetak Dokumen Fisik (cross-cutting, gak masuk fase Domain Roadmap tertentu). **Status:** Ditunda.

## Kasus

Cetakan AR Invoice dan Purchase Order (`docs/domain/print-templates.md`, `memory/domain/print-templates.md`) saat ini cuma menampilkan data transaksi murni (nomor dokumen, tanggal, customer/supplier, item, ringkasan/total). Gak ada:
- **Kop surat resmi** — nama perusahaan (Toko Plastik Makmur Jaya), alamat, NPWP, logo — yang biasanya wajib ada di dokumen resmi yang diserahkan ke pihak eksternal (customer/supplier).
- **Blok tanda tangan** — kolom "Dibuat oleh / Diperiksa oleh / Disetujui oleh" (nama+jabatan+garis tanda tangan kosong, fisik bukan e-signature) yang umum di dokumen bisnis Indonesia.

## Kenapa ditunda

Diputuskan eksplisit oleh user saat desain fitur ini (2026-08-13) — Fase 1 fokus ke mekanisme cetak itu sendiri (live data, bukan snapshot beku) dan cakupan 2 dokumen pertama (AR Invoice, PO). Dua hal ini butuh **data konfigurasi baru yang belum ada** (identitas perusahaan sebagai entity/singleton, daftar penandatangan per jabatan) — bukan cuma soal tampilan cetak, tapi keputusan desain data tersendiri (mirip pola `tax_settings`/`default_account_settings` — konfigurasi singleton), jadi sengaja dipisah dari implementasi cetak dasar biar gak memperlambat rilis kemampuan cetak yang paling mendesak.

## Referensi

- `docs/domain/print-templates.md` submodule "Cakupan Dokumen (Fase 1)"
- `memory/domain/print-templates.md` submodule "Cakupan Dokumen (Fase 1)"
