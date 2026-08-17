# Buat AP Bill (Tagihan dari Supplier)

## Kapan Melakukan Ini

Saat mencatat tagihan dari supplier yang **tidak** berasal dari Goods Receipt (GRN) — misal beban jasa, sewa, atau tagihan lain di luar alur pembelian barang. Kalau bill-nya berasal dari penerimaan barang lewat Purchase Order, bill-nya terbentuk otomatis dari alur GRN, bukan dari form ini.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Supplier-nya sudah ada — kalau belum, buat dulu lewat [tambah-supplier-baru.md](tambah-supplier-baru.md).
- Sudah ada minimal 1 **Kategori Persediaan/Beban** aktif di `/settings/charges` — kalau belum ada, form akan menampilkan peringatan dan tombol kategori tidak akan bisa dipilih.
- Kalau bisnis ini kena PPN Masukan, pastikan pengaturan pajak di `/settings/charges` sudah aktif.

## Langkah-Langkah

1. Buka menu **AP Bills** (`/ap-bills`).
2. Klik tombol **+ New**. Modal **Tambah AP Bill** terbuka.
3. Cek panel preview jurnal di atas form untuk lihat akun apa yang bakal kena debit/kredit.
4. Isi field:
   - **Supplier** — pilih dari dropdown (menampilkan nama + termin, mis. "PT Plastindo Jaya (net-30)").
   - **Tanggal** — tanggal bill. Jatuh tempo dihitung otomatis dari tanggal ini + termin supplier.
   - **Nomor Nota Supplier** (opsional) — nomor asli dari nota fisik supplier, dicatat terpisah dari Source Ref internal sistem.
   - **Deskripsi** — keterangan singkat transaksi.
   - **Jumlah** — nilai pokok tagihan (sebelum biaya tambahan/PPN).
   - **Kategori Persediaan/Beban** — pilih kategori yang menentukan akun debit utama (wajib diisi, beda dari AR yang otomatis pakai 1 akun pendapatan tetap).
   - **Akun Utang Usaha** — field terkunci, diambil otomatis dari Default Account Settings.
5. (Opsional) **Kategori Debit Tambahan** — tambahkan baris kalau bill ini juga mencatat biaya lain (mis. ongkir supplier).
6. (Opsional, hanya muncul kalau PPN aktif) Centang **Kena PPN Masukan** kalau tagihan ini kena pajak masukan.
7. Klik **Simpan Bill**.

## Hasil Akhir

- Bill baru muncul di tabel AP Bills dengan Source Ref otomatis, status **belum**, dan tipe **Bill Langsung**.
- Jurnal otomatis terbentuk: debit Kategori Persediaan/Beban yang dipilih (+ baris tambahan/PPN kalau diisi), kredit Akun Utang Usaha.
- Bill ini sekarang bisa dibayar lewat [bayar-bill-ap.md](bayar-bill-ap.md).

## Kesalahan Umum

- **Lupa isi Kategori Persediaan/Beban** — field ini wajib (beda dari AR invoice yang otomatis pakai akun pendapatan default); tanpa ini, bill tidak bisa disimpan.
- **Menukar Nomor Nota Supplier dengan Source Ref internal** — dua-duanya field terpisah dan tidak saling menggantikan; Source Ref selalu format otomatis sistem, Nomor Nota Supplier adalah nomor asli dari kertas nota fisik.
- **Menganggap form ini bisa dipakai untuk bill yang sudah lewat GRN** — itu duplikat, bill dari GRN sudah otomatis terbentuk di alur penerimaan barang.
