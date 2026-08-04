# AR — Overpayment Jadi Saldo Kredit Customer

**Modul asal:** Accounts Receivable (Fase 3). **Status:** Ditunda.

## Kasus

Customer bayar lebih dari yang diutang (misal invoice Rp500.000, transfer Rp550.000 karena salah nominal). Kelebihan Rp50.000 idealnya jadi "kredit" yang bisa dipakai nutup invoice berikutnya, bukan hilang atau nyangkut.

## Kenapa ditunda

Trigger `ar_payment_allocations_no_over_allocation` (`memory/architecture/data/ar-schema.md`) sekarang **nolak keras** alokasi yang bikin total alokasi ngelebihin `amount` invoice — jadi kelebihan bayar gak punya tempat "nyantol". Buat nampung ini butuh salah satu:
- Kolom `unallocated_amount` di `ar_payments` (payment boleh gak teralokasi penuh, sisanya nunggu invoice baru).
- Atau entitas "customer credit balance" terpisah — mungkin bisa nyontek pola tabel `ar_deposits` (AR Deposit, udah diimplementasi, `memory/architecture/data/ar-schema.md` bagian "AR Deposit"), tapi **beda kasus**: DP itu duit yang emang belum ada piutangnya sama sekali, overpayment itu piutang yang UDAH ada tapi dibayar kelebihan — butuh keputusan desain sendiri, bukan sekadar reuse tabel yang sama.

## Kapan perlu digarap

Begitu ada kejadian nyata kelebihan bayar di cerita CV Roti Barokah.

## Referensi

- `docs/domain/accounts-receivable.md` (bagian "Belum Termasuk", constraint #3)
- `memory/architecture/data/ar-schema.md` (trigger `ar_payment_allocations_no_over_allocation`)
