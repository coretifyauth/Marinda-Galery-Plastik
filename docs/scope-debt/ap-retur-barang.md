# AP — Retur Barang ke Supplier

**Modul asal:** Accounts Payable (Fase 4, masih tahap desain konsep). **Status:** Ditunda.

## Kasus

Bahan baku yang diterima dari supplier (misal tepung apek/rusak) dikembalikan. Utang berkurang tanpa ada pembayaran — supplier kasih "potongan utang" (credit note dari sisi mereka), bukan uang balik ke CV Barokah.

## Kenapa ditunda

Padanan langsung dari [ar-retur-barang.md](ar-retur-barang.md), cuma arah kebalik (kita yang nerima retur di AR, kita yang ngajuin retur di AP). Sama-sama butuh desain "credit note" yang bisa **partial** dan bisa kejadian **setelah** ada payment sebagian — beda dari guard `cancel_ap_bill` (rencana: sama pola `cancel_ar_invoice`, cuma boleh kalau belum ada alokasi payment sama sekali).

## Kapan perlu digarap

Bareng `ar-retur-barang.md` kalau desainnya mau disatuin (kemungkinan besar solusinya sama, cuma beda arah tabel), atau begitu ada kejadian retur nyata di cerita CV Roti Barokah dari sisi supplier.

## Referensi

- [ar-retur-barang.md](ar-retur-barang.md)
- Percakapan desain AP (kasus 5)
