# AP — Uang Muka / DP ke Supplier

**Modul asal:** Accounts Payable (Fase 4, masih tahap desain konsep). **Status:** Ditunda.

## Kasus

Supplier minta dibayar duluan sebagian sebelum kirim bahan baku (uang muka pembelian) — kebalikan dari [ar-uang-muka-dp.md](ar-uang-muka-dp.md) (customer bayar duluan ke kita).

## Kenapa ditunda

Sama alasan padanannya di AR: rencana `record_ap_payment` (mirror `record_ar_payment`) bakal wajib minimal 1 alokasi ke bill yang udah ada — gak ada jalur "payment nganggur belum teralokasi" buat nampung DP sebelum bill-nya kebentuk.

## Kapan perlu digarap

Bareng `ar-uang-muka-dp.md` (solusi kemungkinan sama, cuma beda arah), atau begitu ada supplier di cerita yang minta DP.

## Referensi

- [ar-uang-muka-dp.md](ar-uang-muka-dp.md)
- Percakapan desain AP (kasus 7)
