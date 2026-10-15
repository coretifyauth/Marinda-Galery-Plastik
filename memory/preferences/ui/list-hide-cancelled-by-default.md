# List: Dokumen Dibatalkan/Pembalikan Disembunyikan by Default

Diputuskan 2026-10-15 (preferensi user): list dokumen tidak menampilkan yang dibatalkan secara default — data tidak valid tidak perlu mengganggu pandangan sehari-hari. Bisa dilihat lewat filter.

## Pola

- List dengan filter status (Tagihan AP, Invoice AR, POS, Purchase Order, Sales Order): nilai filter `"aktif"` jadi default (opsi "Aktif (tanpa dibatalkan)"), query pakai `.neq("status", <nilai dibatalkan>)`. "Semua status" dan "Dibatalkan" tetap tersedia.
- Barang Masuk / Barang Keluar: status diturunkan dari transaksi pasangannya, filter lewat embed `transactions!inner` + `.neq("<alias>.status", "dibatalkan")`.
- Jurnal Umum: jurnal pembalikan DAN jurnal asli yang sudah dibalik disembunyikan, checkbox "Tampilkan pembalikan" untuk melihatnya (embed self-FK `reversed_by` + `.is("reversed_by", null)`).
- Saat baris dibatalkan ditampilkan (filter diganti), tampilannya mencolok: lihat `apps/erp/src/components/ui/cancelled.tsx`.
- Deposit (AR/AP) tidak punya status dibatalkan, tidak ikut pola ini.
