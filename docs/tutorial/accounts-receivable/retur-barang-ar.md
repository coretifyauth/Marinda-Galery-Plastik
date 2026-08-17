# Catat Retur Barang dari Pelanggan (AR Credit Note)

## Kapan Melakukan Ini

Saat pelanggan mengembalikan sebagian atau seluruh barang dari invoice yang sudah dibuat — baik invoice itu berasal dari Goods Issue (stok ikut disentuh) maupun invoice financial-only (murni pengurangan piutang, tanpa stok).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Invoice-nya sudah ada dan belum dibatalkan.

## Langkah-Langkah

1. Buka detail invoice (`/ar-invoices/[id]`) yang barangnya diretur.
2. Klik tombol **Catat Retur**. Baca dulu keterangan di atas form — beda perlakuan tergantung asal invoice:
   - **Invoice dari Goods Issue**: isi qty per item yang balik, stok & HPP otomatis ke-reverse proporsional.
   - **Invoice financial-only (bukan dari Goods Issue)**: retur cuma mengurangi piutang (kontra-revenue), tidak ada stok yang disentuh.
3. Isi **Tanggal Retur**.
4. Isi **Nominal Retur** — kalau invoice dari Goods Issue dan item retur berasal dari Sales Order (punya harga jual tercatat), nominal ini **otomatis terhitung** dari qty × harga jual dan field-nya terkunci; kalau tidak, isi manual.
5. (Khusus invoice dari Goods Issue) Untuk tiap baris item, isi **Qty Retur** dan pilih **Kondisi**: **Layak Jual** (masuk lagi ke stok) atau **Rusak** (dicatat sebagai beban kerugian, tidak masuk stok).
6. Klik **Simpan Retur**.

## Hasil Akhir

- Jurnal retur terbentuk: debit Akun Retur & Potongan Penjualan, kredit Piutang Usaha.
- Kalau nominal retur melebihi sisa outstanding invoice ini, kelebihannya otomatis jadi **Saldo Kredit Retur Customer** (bisa direfund tunai belakangan) — bukan dipaksa jadi piutang negatif.
- Untuk invoice dari Goods Issue: item dengan kondisi **Layak Jual** masuk lagi ke stok (debit Persediaan Barang Jadi), item **Rusak** dicatat sebagai beban kerugian — keduanya mengkredit HPP untuk reverse pencatatan HPP asli secara proporsional.
- Retur ini bisa ditindaklanjuti dua arah: [tukar-barang-garansi.md](tukar-barang-garansi.md) (customer minta barang pengganti, bukan uang) atau refund tunai saldo kreditnya lewat tombol **Refund Tunai Saldo Kredit Retur** kalau ada saldo kredit aktif.

## Kesalahan Umum

- **Isi Nominal Retur manual padahal seharusnya otomatis** — field ini terkunci (tidak bisa diedit) begitu sistem bisa menghitungnya sendiri dari harga jual tercatat; kalau ada peringatan "item retur yang gak punya harga jual tercatat", baru isi manual.
- **Salah pilih Kondisi jadi "Layak Jual" untuk barang yang sebenarnya rusak** — ini akan membuat stok bertambah untuk barang yang sebenarnya tidak layak dijual lagi.
- **Lupa retur bisa melebihi outstanding invoice** — itu bukan error, itu memang menjadi saldo kredit yang bisa dipakai lagi (refund atau tukar barang), bukan kondisi yang harus dihindari.
