# Hapusbukukan Piutang Tak Tertagih (Bad Debt Write-off)

## Kapan Melakukan Ini

Saat piutang dari suatu invoice dipastikan **tidak akan tertagih** (customer menghilang/tutup usaha) — bukan sekadar telat bayar biasa. Ini langkah terakhir dari eskalasi piutang bermasalah (reminder → credit hold → renegosiasi → write-off).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Sudah cukup yakin piutang ini benar-benar tidak akan tertagih — write-off bukan tindakan yang mudah dibatalkan secara wajar (lihat catatan di bawah).

## Langkah-Langkah

1. Buka detail invoice (`/ar-invoices/[id]`) yang piutangnya mau dihapusbukukan.
2. Klik tombol **Hapusbukukan**. Baca catatan di modal: **Pendapatan asli tidak dibalik** — penjualannya tetap dianggap terjadi, cuma piutangnya yang dihapuskan lewat beban baru.
3. Isi **Tanggal Write-off**.
4. Isi **Nominal Write-off** — boleh sebagian, tidak boleh melebihi sisa outstanding (batas maksimum ditampilkan di label field).
5. Klik **Simpan Write-off**.

## Hasil Akhir

- Jurnal terbentuk: debit Akun Beban Piutang Tak Tertagih, kredit Piutang Usaha.
- Outstanding invoice berkurang sejumlah nominal write-off — kalau ditulis penuh, invoice ini jadi berstatus lunas dari sisi piutang, meski uangnya tidak pernah benar-benar diterima.
- Pendapatan penjualan yang tercatat sejak awal **tetap utuh** — write-off cuma memindahkan efek "tidak tertagih" jadi beban, bukan membatalkan penjualannya.

## Kesalahan Umum

- **Mengira write-off sama dengan pembatalan invoice** — beda total: pembatalan (lihat [batalkan-invoice-ar.md](batalkan-invoice-ar.md)) membalik seluruh pendapatan seolah transaksinya tidak pernah terjadi; write-off tetap mengakui pendapatannya, cuma mengakui piutangnya sudah tidak bisa ditagih.
- **Write-off untuk piutang yang sebenarnya masih mungkin tertagih (cuma telat)** — pertimbangkan dulu jalur credit hold/renegosiasi (lihat [cek-credit-hold-pelanggan.md](cek-credit-hold-pelanggan.md)) sebelum langsung write-off; write-off idealnya untuk kasus yang sudah jelas tidak akan tertagih.
- **Write-off melebihi sisa outstanding** — sistem menolak; field-nya dibatasi maksimum sesuai outstanding yang tersisa saat itu.
