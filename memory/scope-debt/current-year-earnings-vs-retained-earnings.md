# Pemisahan Laba Tahun Berjalan vs Laba Ditahan

**Modul asal:** General Ledger / Period Closing (Fase 7), Financial Reports. **Status:** Ditunda.

## Kasus

`close_period` sekarang nutup akun Revenue/Expense LANGSUNG ke satu akun equity pilihan user (biasanya `3200 Laba Ditahan`) apa pun rentang tanggalnya — sistem ini sengaja fleksibel soal kapan boleh tutup (mingguan/bulanan/tahunan, bebas, gak hardcode). Akibatnya laba yang masih "hidup" (tahun berjalan, belum final) langsung campur jadi satu saldo dengan akumulasi laba tahun-tahun sebelumnya yang sudah final — gak bisa dibedain lagi dari saldo akun itu sendiri begitu closing bulanan/kuartalan dijalankan berkali-kali dalam satu tahun fiskal.

Contoh: usaha untung Rp10 juta di 2025 (ditutup akhir Desember 2025 → masuk `3200 Laba Ditahan`). Tahun 2026 sampai Agustus untung Rp4 juta (masih berjalan, belum resmi ditutup tahunan). Kalau user sempat tutup buku bulanan di antaranya (Januari, Februari, dst — sistem ini mengizinkan itu), saldo `3200 Laba Ditahan` per Agustus 2026 langsung nunjukin Rp14 juta — gabungan laba final 2025 + laba 2026 yang masih berjalan — bukan 2 angka terpisah (`Laba Ditahan` Rp10jt + `Laba Tahun Berjalan` Rp4jt).

`getBalanceSheet` (lihat `docs/architecture/financial-reports-schema.md` bagian "Balance Sheet") punya gejala yang sama dari sisi laporan: baris `Laba Ditahan` di Neraca dihitung ulang sebagai SATU angka derived (`Laba Bersih` dari `getIncomeStatement("sejak awal sistem", asOfDate)`), bukan 2 baris terpisah current-year vs prior-years.

## Kenapa ditunda

Ini perubahan desain skema + proses bisnis yang cukup besar, bukan sekadar tambah kolom:
- Perlu keputusan: 2 akun equity terpisah (`Laba Tahun Berjalan` + `Laba Ditahan`), atau 1 akun dengan metadata "closing ini final tahun fiskal mana" yang dibaca laporan?
- `close_period` perlu dibedain jadi 2 jenis closing — interim/periodik (buat pelaporan, gak benar-benar "final") vs tahunan/final (yang beneran roll ke Laba Ditahan) — sekarang cuma ada 1 jenis (hard close, lihat `docs/domain/general-ledger.md` bagian "Period Closing").
- Belum ada kebutuhan bisnis nyata yang mendesak — baru muncul dari diskusi eksploratif (2026-08-16), bukan dari kasus pemakaian riil (mis. permintaan distribusi dividen/prive yang butuh tahu mana laba yang "sudah matang" buat ditarik).
- Di luar scope kerjaan pagination+filter yang lagi dikerjakan sesi ini (`memory/architecture/app/tech-stack-decisions.md`, "Data-fetching ERP").

## Kapan perlu digarap

Begitu ada kebutuhan bisnis nyata — mis. owner mau lihat "laba tahun ini doang" terpisah dari akumulasi historis di laporan, atau mau fitur distribusi laba/dividen/prive yang perlu membedakan mana laba yang boleh ditarik (sudah final) vs yang belum (tahun berjalan).

## Referensi

- `docs/domain/general-ledger.md` bagian "Period Closing (Tutup Buku)"
- `docs/domain/general-ledger.md` bagian "Period Closing (Tutup Buku)"
- `docs/architecture/financial-reports-schema.md` bagian "Balance Sheet" dan "Tutup Buku (Period Closing)"
- `supabase/migrations/0008_period_closing_schema.sql` (fungsi `close_period`)
