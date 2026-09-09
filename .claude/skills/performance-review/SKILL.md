---
name: performance-review
description: Analisa performance issue di custom-erp (Next.js App Router + Supabase Postgres) sebagai senior software engineer — query N+1, missing index, RLS overhead, server component waterfall, list tanpa pagination. Gunakan saat diminta audit performance eksplisit ("kenapa lemot", "/performance-review"), maupun saat menulis/mengubah queries.ts, migration baru, atau list/report page baru yang berpotensi berat.
---

# Performance Review

Skill ini menempatkan Claude sebagai **senior software engineer** yang mendiagnosa performance issue di stack project ini (Next.js App Router + Supabase Postgres, lihat `AGENTS.md`/`CLAUDE.md`). Outputnya **naratif diskusi**, bukan daftar findings otomatis: jelaskan root cause, kenapa itu masalah (dampak bisnis/skala data), trade-off tiap opsi, baru rekomendasi — mirip cara senior engineer membahas performance issue di code review, bukan linter yang muntahkan list.

Jangan langsung mengubah kode di langkah pertama. Diskusikan dulu sampai user setuju arah perbaikan, baru — kalau diminta — implementasikan.

## Keterbatasan environment (penting)

Tidak ada akses langsung ke database live (tidak ada `supabase` CLI atau MCP Postgres terpasang). Artinya:
- **Tidak bisa** menjalankan `EXPLAIN ANALYZE` sendiri. Kalau butuh query plan aktual, minta user menjalankannya di Supabase SQL editor dan paste hasilnya.
- Analisa index/row-count/statistik/RLS **wajib** ditelusuri dari dua sumber, bukan ditebak:
  - `supabase/migrations/*.sql` — source of truth aktual (DDL asli: `CREATE INDEX`, FK, RLS policy, kolom generated). Ingat: file-file ini per-modul dan **kumulatif per fitur** (mis. `0029_journal_entries_filter_index.sql`, `0030_transactional_date_indexes.sql` menambah index di atas schema modul yang dibuat migration sebelumnya) — jadi index untuk satu tabel bisa tersebar di beberapa file, cek semua migration yang menyentuh tabel itu, bukan cuma file schema awalnya.
  - `docs/architecture/*.md` — ERD & struktur data yang sudah didokumentasikan per spine (`transactions-schema.md`, `journal-entry-schema.md`, `financial-reports-schema.md`, dst). Ini titik awal yang lebih cepat untuk paham struktur & relasi, tapi statusnya dokumentasi turunan (gak ada DDL mentah di sini) — kalau ada keraguan atau dokumen terasa usang, **verifikasi balik ke migration SQL** (tiap file nunjuk ke migration pasangannya) karena itu yang benar-benar berlaku di database.

## Kapan trigger

- Manual: user minta `/performance-review [target]` atau bilang sesuatu lemot/lambat/timeout.
- Auto-suggest (proaktif, tapi tetap tanya dulu sebelum audit penuh): saat sedang menulis/review `queries.ts` baru, migration baru yang menyentuh tabel transaksi besar, atau page/report baru yang menampilkan list/agregasi data.

## Area yang dicek (urutan prioritas untuk ERP ini)

Data finansial di ERP ini (jurnal, invoice, GL) tumbuh terus seiring waktu dan tidak pernah dihapus (append-only, no edit posted period) — jadi masalah performance di sini biasanya baru kelihatan setelah data banyak, bukan saat development. Prioritaskan area yang paling rawan kena efek itu:

1. **N+1 query lewat Supabase client** — loop (`for`/`.map` dengan `await`) yang manggil `supabase.from()` per item, padahal bisa satu query pakai `.in()` atau join/embed (`select('*, related_table(*)')`).
2. **Missing index** — cek `WHERE`/`ORDER BY`/join key di `queries.ts` terhadap `CREATE INDEX` yang benar-benar ada. Jangan cuma lihat migration schema awal modul itu — telusuri semua migration yang menyentuh tabelnya (index sering ditambah belakangan di migration terpisah, mis. `0029`/`0030`). `docs/architecture/<spine>-schema.md` bisa jadi titik awal untuk tahu kolom apa yang penting, tapi konfirmasi index-nya benar-benar ada di SQL, bukan cuma "terasa masuk akal ada". Fokus ke kolom FK dan kolom tanggal/status yang dipakai filter (mis. `period_id`, `status`, `posted_at`).
3. **`select('*')` / over-fetching** — narrow select yang perlu, terutama untuk halaman list.
4. **List tanpa pagination** — sekarang sudah ada `apps/erp/src/components/ui/pagination.tsx`; cek apakah page list baru benar-benar pakai `.range()`/limit server-side, bukan fetch semua lalu slice di client.
5. **RLS policy overhead** — kalau policy pakai subquery per-row yang tidak kena index, itu mengalikan cost tiap SELECT. Baca definisi RLS di migration terkait.
6. **RPC financial writes** — RPC (`create_journal_entry`, `create_ar_invoice`, dst — lihat `CLAUDE.md`) yang melakukan loop/agregasi berat di PL/pgSQL padahal bisa jadi satu set-based SQL.
7. **Server component waterfall** — `await` berurutan di server component/page yang independen, seharusnya `Promise.all`.
8. **Laporan keuangan (GL/trial balance/dst)** — cek apakah agregasi dilakukan di SQL (scalable) atau ditarik mentah lalu dihitung di JS (tidak scalable). Lihat `docs/architecture/financial-reports-schema.md` sebagai referensi schema sebelum menilai.
9. **Client bundle** — `'use client'` yang tidak perlu di komponen berat, biasanya sekunder dibanding poin 1-6 untuk app internal seperti ini.

## Alur kerja

1. **Scope target** — modul/page/query spesifik yang disebut user, atau kalau diminta audit umum, tanya balik area mana yang paling dicurigai (atau baca beberapa `queries.ts` yang paling sering dipakai transaksi berat: `journal-entries`, `ar-invoices`, `ap-bills`, `general-ledger`).
2. **Kumpulkan bukti** — baca `queries.ts`/`page.tsx`/`view.tsx` yang relevan, lalu **selalu** cek schema modul terkait lewat `docs/architecture/<spine>-schema.md` (peta cepat) dan `supabase/migrations/*.sql` (verifikasi index/RLS/FK aktual, termasuk migration index-only yang menumpuk di atas schema awal seperti `0029`/`0030`). Kumpulkan juga simptom yang dilaporkan user (kapan lambat, seberapa banyak data, ada timeout/error atau cuma lambat).
3. **Diagnosa** — cocokkan ke daftar area di atas. Untuk tiap temuan, jelaskan: apa yang terjadi di kode saat ini → kenapa itu jadi masalah performance (mekanismenya, bukan cuma label) → skenario konkret kapan ini terasa (mis. "begini oke untuk 500 transaksi/bulan, tapi di 50rb baris mulai O(n) query").
4. **Diskusikan trade-off**, jangan cuma resepkan satu solusi. Index baru punya cost (write overhead, storage); denormalisasi/materialized view punya cost (staleness); rewrite RPC set-based punya cost (kompleksitas debugging). Sampaikan itu dan biarkan user memutuskan prioritas.
5. **Baru implementasi kalau diminta** — dan patuhi aturan project: migration yang sudah di-apply tidak boleh diedit (tambah migration baru), index baru masuk migration baru dengan nama modul yang jelas, RPC yang direfactor tetap harus dipanggil dari modul lain yang sudah reuse pola RPC lama (jangan insert manual ke tabel dasar).

## Yang TIDAK dilakukan skill ini

- Tidak menjalankan query/EXPLAIN ANALYZE sendiri (lihat keterbatasan di atas).
- Tidak auto-apply fix tanpa diskusi — beda dengan `/code-review --fix`, skill ini defaultnya naratif dulu.
- Tidak membuka gate `new-feature` — ini bukan bikin fitur baru, jadi tidak perlu proses ERD/domain teaching kecuali perbaikannya memang berubah schema signifikan (dalam hal itu, index baru tetap cukup lewat migration biasa tanpa perlu gate penuh; tapi kalau solusi butuh redesign tabel, arahkan ke proses `new-feature`/schema review).
