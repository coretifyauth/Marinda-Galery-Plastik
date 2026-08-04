# AP — Uang Muka / DP ke Supplier

**Modul asal:** Accounts Payable (Fase 4, masih tahap desain konsep). **Status:** Ditunda.

## Kasus

Supplier minta dibayar duluan sebagian sebelum kirim bahan baku (uang muka pembelian) — kebalikan dari AR Deposit (customer bayar duluan ke kita, udah diimplementasi — `memory/domain/accounts-receivable.md` bagian "Uang Muka / DP").

## Kenapa ditunda

Belum ada supplier di cerita CV Roti Barokah yang minta DP. Solusinya bisa nyontek pola AR Deposit yang udah jadi (BUKAN "payment boleh nganggur" — itu ide awal yang ternyata gak dipakai di sisi AR, karena secara akuntansi DP itu kewajiban terpisah, bukan pengurang Utang Usaha langsung): akun liability baru mirror `Uang Muka Penjualan` (misal `Uang Muka Pembelian`), tabel mirror `ar_deposits`/`ar_deposit_applications` (gak ada padanan "hangus" di sisi AP — kita yang DP, kita yang kena hangus kalau batalin, itu beban bukan pendapatan, logic-nya kebalik).

## Kapan perlu digarap

Begitu ada supplier di cerita yang minta DP — desainnya nyontek pola AR Deposit yang udah diimplementasi (`memory/architecture/data/ar-schema.md` bagian "AR Deposit").

## Referensi

- `memory/domain/accounts-receivable.md` (bagian "Uang Muka / DP") — pola AR Deposit yang jadi rujukan
- `memory/architecture/data/ar-schema.md` (bagian "AR Deposit") — DDL/RPC yang bisa dicontek arahnya
- Percakapan desain AP (kasus 7)
