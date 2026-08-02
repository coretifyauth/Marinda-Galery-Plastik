# AR — Credit Hold (Tahan Kredit Customer Telat Bayar)

**Modul asal:** Accounts Receivable (Fase 3). **Status:** Ditunda ("soon", disepakati pas bahas kasus Warung Pak Budi telat bayar).

## Kasus

Kalau customer punya piutang overdue yang menumpuk (bukan cuma telat beberapa hari), penjual (CV Barokah) biasanya **berhenti kasih termin baru** ke customer itu — invoice berikutnya harus cash, atau ditolak dulu sampai piutang lama lunas. Ini tindakan standar level ke-2 dari 4 tindakan penjual ke piutang telat (reminder → **credit hold** → renegosiasi cicilan → write-off, lihat [ar-piutang-tak-tertagih.md](ar-piutang-tak-tertagih.md)).

## Kenapa ditunda

`create_ar_invoice` sekarang gak ada validasi apa pun soal outstanding customer — invoice baru selalu bisa dibuat berapa pun piutang lama yang belum lunas. Butuh keputusan desain:
- Ada **limit piutang** per customer (kolom baru di `customers`, misal `credit_limit`)? Atau cuma aturan "kalau ada invoice overdue, tolak invoice baru"?
- Validasi ini di level RPC (`create_ar_invoice` nolak keras) atau cuma warning di UI (accountant tetep bisa override manual)?

## Kapan perlu digarap

Konteks nyata: Warung Pak Budi (invoice 7 Juli, due 21 Juli, belum dibayar sampai 30 Juli — lihat `docs/story/accounts-receivable.md` skenario 3) jadi trigger diskusi ini. Belum diimplementasi karena baru telat 9 hari, belum dianggap kasus kritis. Digarap begitu ada kejadian customer yang telat berbulan-bulan atau menumpuk banyak invoice overdue sekaligus.

## Referensi

- Percakapan desain AR (konteks bisnis piutang telat, 4 tindakan penjual)
- `docs/story/accounts-receivable.md` (skenario 3, Warung Pak Budi)
