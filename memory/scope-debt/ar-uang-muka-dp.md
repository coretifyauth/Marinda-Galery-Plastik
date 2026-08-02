# AR — Uang Muka / DP Sebelum Invoice Ada

**Modul asal:** Accounts Receivable (Fase 3). **Status:** Ditunda.

## Kasus

Customer (warung) bayar duluan sebelum ada invoice — misal titip DP buat pesanan roti kue spesial yang belum dikirim. Sistem sekarang **asumsi payment selalu dialokasikan penuh ke invoice yang udah ada saat itu juga** — `record_ar_payment` wajib minimal 1 alokasi (`recordArPaymentSchema` di `src/lib/ar-payments/schema.ts`, min 1 item array), gak ada jalur "payment nganggur belum teralokasi".

## Kenapa ditunda

Butuh keputusan desain: payment boleh dibuat dengan 0 alokasi (status "unapplied credit"), lalu dialokasikan belakangan begitu invoice-nya kebentuk. Ini ngubah constraint `record_ar_payment` (yang sekarang treat "amount = total alokasi" sebagai invariant wajib) dan nambah state baru di UI (list payment yang "belum teralokasi penuh").

## Kapan perlu digarap

Begitu ada skenario nyata customer nitip DP di cerita CV Roti Barokah, atau kalau pola bisnis pre-order mulai dipakai.

## Referensi

- `docs/domain/accounts-receivable.md` (bagian "Belum Termasuk")
- `memory/architecture/data/ar-schema.md` (bagian "Belum termasuk")
