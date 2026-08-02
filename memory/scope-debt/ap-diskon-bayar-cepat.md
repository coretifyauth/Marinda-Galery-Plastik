# AP — Diskon Bayar Cepat (Early Payment Discount)

**Modul asal:** Accounts Payable (Fase 4, masih tahap desain konsep). **Status:** Ditunda.

## Kasus

Supplier sering kasih termin kayak "2/10, net 30" — bayar dalam 10 hari dapet diskon 2%, kalau lewat ya bayar penuh sampe hari ke-30. Contoh: bill Rp800.000, bayar hari ke-8 → CV Barokah cuma transfer Rp784.000 (diskon Rp16.000), tapi utang yang dianggap lunas tetap Rp800.000 penuh.

## Kenapa ditunda

Jurnal pelunasan biasa (rencana `record_ap_payment`, mirror `record_ar_payment`) cuma 2 baris: Debit Utang Usaha, Kredit Kas — sejumlah yang **sama persis** dengan yang dialokasikan. Diskon butuh **3 baris**: Debit Utang Usaha 800.000 | Kredit Kas 784.000, Kredit Diskon Pembelian 16.000. Ini artinya:
- `amount` yang ditransfer (784rb) beda dari `amount` yang dialokasikan buat nutup bill (800rb) — invariant "amount dibayar = total alokasi" yang dipakai di AR (`recordArPaymentSchema`) gak berlaku lagi di sini.
- Butuh akun baru `Diskon Pembelian` (kategori revenue-contra atau expense-contra, belum ada di `chart-of-accounts.md`).
- Butuh field tambahan per payment (jumlah diskon) atau dihitung dari selisih tanggal bayar vs term diskon supplier.

## Kapan perlu digarap

Begitu ada supplier di cerita CV Roti Barokah yang emang nawarin skema diskon ini (belum ada — Toko Tepung Makmur/Toko Gula Sejahtera saat ini asumsi termin polos, gak ada diskon).

## Referensi

- Percakapan desain AP (kasus 6)
