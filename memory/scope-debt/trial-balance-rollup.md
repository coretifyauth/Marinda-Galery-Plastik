# General Ledger — Fungsi Rollup Saldo per Akun

**Modul asal:** General Ledger (Fase 2). **Status:** Ditunda ke Fase 7 (Financial Reports).

## Kasus

Trial Balance/Neraca butuh saldo tiap akun (termasuk rollup header dari saldo semua leaf child-nya) dihitung dari `SUM(debit)-SUM(credit)` di `journal_lines`, dikelompokkan per `account_id` dan digabung naik ke parent header lewat `accounts.parent_id`.

## Kenapa ditunda

Ini query read-side murni (gak butuh kolom/tabel baru), tapi belum ditulis karena belum ada konsumennya — halaman `/general-ledger` sekarang cuma nampilin histori + saldo berjalan 1 akun leaf yang dipilih user, belum ada agregat lintas akun buat Trial Balance.

## Kapan perlu digarap

Fase 7 (Financial Reports), begitu Balance Sheet/Trial Balance mulai dibangun. Desainnya kemungkinan SQL view atau RPC read-only (`get_trial_balance(as_of date)`), bukan tabel baru.

## Referensi

- `memory/architecture/data/journal-entry-schema.md` (bagian "Konsep Inti" > DDL `journal_lines`)
