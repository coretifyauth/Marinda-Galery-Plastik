# AP — Retur Barang ke Supplier

**Modul asal:** Accounts Payable (Fase 4, masih tahap desain konsep). **Status:** Ditunda.

## Kasus

Bahan baku yang diterima dari supplier (misal tepung apek/rusak) dikembalikan. Utang berkurang tanpa ada pembayaran — supplier kasih "potongan utang" (credit note dari sisi mereka), bukan uang balik ke CV Barokah.

## Kenapa ditunda

Padanan langsung dari AR Credit Note (retur barang, sudah diimplementasi — `memory/domain/accounts-receivable.md` bagian "Retur Barang"), cuma arah kebalik (kita yang nerima retur di AR, kita yang ngajuin retur di AP). Sama-sama butuh desain "credit note" yang bisa **partial** dan bisa kejadian **setelah** ada payment sebagian — beda dari guard `cancel_ap_bill` (rencana: sama pola `cancel_ar_invoice`, cuma boleh kalau belum ada alokasi payment sama sekali).

## Kapan perlu digarap

Desainnya bisa nyontek langsung pola AR Credit Note (kemungkinan besar solusinya sama, cuma beda arah tabel), begitu ada kejadian retur nyata di cerita CV Roti Barokah dari sisi supplier.

## Referensi

- `memory/domain/accounts-receivable.md` (bagian "Retur Barang") — pola AR Credit Note yang jadi rujukan
- Percakapan desain AP (kasus 5)
