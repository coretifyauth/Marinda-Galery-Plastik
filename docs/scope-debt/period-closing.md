# General Ledger — Period Closing (Tutup Buku)

**Modul asal:** General Ledger (Fase 2). **Status:** Ditunda ke Fase 7 (Financial Reports).

## Kasus

Proses akhir periode (bulanan/tahunan): akun Revenue & Expense di-nol-kan lewat closing entry (selisih laba/rugi dipindah ke `Laba Ditahan`), lalu periode dikunci — gak ada entry baru boleh bertanggal masuk ke periode itu lagi. Konsep lengkap + contoh angka ada di `docs/domain/human/general-ledger.md` (bagian "Period Closing").

## Kenapa ditunda

Butuh laporan keuangan (Income Statement) jalan dulu buat tau total definitif Revenue/Expense per akun yang mau ditutup — gak bisa dibangun sebelum mesin laporan ada. Beda level dari constraint immutability entry (`journal_entries`/`journal_lines` udah immutable sejak entry pertama, independen dari period closing).

## Kapan perlu digarap

Fase 7 (Financial Reports) di roadmap `AGENT.md`, begitu Income Statement/Balance Sheet mulai dibangun.

## Referensi

- `docs/domain/human/general-ledger.md` (bagian "Period Closing")
- `docs/architecture/data/journal-entry-schema.md` (bagian "Belum termasuk")
