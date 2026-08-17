# Buat AR Invoice (Tagihan ke Pelanggan)

## Kapan Melakukan Ini

Saat menagih pelanggan untuk penjualan dengan termin (belum dibayar tunai saat itu juga) yang **tidak** berasal dari Sales Order atau Goods Issue otomatis — misal jasa, penjualan yang dicatat manual, atau tagihan lain di luar alur inventory. Kalau penjualannya berasal dari Sales Order atau Goods Issue, invoice-nya terbentuk otomatis dari alur itu, bukan dari form ini.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Customer-nya sudah ada — kalau belum, buat dulu lewat [tambah-pelanggan-baru.md](tambah-pelanggan-baru.md).
- Kalau ada kategori pendapatan tambahan (mis. jasa antar) yang mau dipakai, pastikan **Kategori Biaya/Pendapatan** terkait sudah disetel di `/settings/charges`.
- Kalau bisnis ini kena PPN Keluaran, pastikan pengaturan pajak di `/settings/charges` sudah aktif — kalau tidak aktif, checkbox PPN tidak akan muncul di form ini.

## Langkah-Langkah

1. Buka menu **AR Invoices** (`/ar-invoices`).
2. Klik tombol **+ New**. Modal **Tambah AR Invoice** terbuka.
3. Di bagian atas modal ada panel **preview jurnal** — ini menampilkan akun apa yang bakal kena debit/kredit begitu invoice disimpan. Cek panel ini kalau ragu efek akuntansinya sebelum isi form.
4. Isi field:
   - **Customer** — pilih dari dropdown (menampilkan nama + termin, mis. "Warung Bu Siti (net-7)").
   - **Tanggal** — tanggal invoice terbit. Jatuh tempo dihitung otomatis dari tanggal ini + termin customer.
   - **Deskripsi** — keterangan singkat transaksi.
   - **Jumlah** — nilai pokok penjualan (sebelum biaya tambahan/PPN).
   - **Akun Piutang Usaha** dan **Akun Pendapatan** — field ini terkunci (locked), diambil otomatis dari Default Account Settings, tidak bisa diubah manual di form ini.
5. (Opsional) **Kategori Pendapatan Tambahan** — tambahkan baris kalau invoice ini juga menagih biaya lain (mis. jasa antar), pilih kategorinya dan isi nominalnya.
6. (Opsional, hanya muncul kalau PPN aktif di pengaturan) Centang **Kena PPN Keluaran** kalau transaksi ini kena pajak — nominal PPN dihitung otomatis dari subtotal, tidak perlu dihitung manual.
7. Klik **Simpan Invoice**.

## Hasil Akhir

- Invoice baru muncul di tabel AR Invoices dengan **Source Ref** otomatis, status **belum** (belum dibayar), dan tipe **Financial Only**.
- Jurnal otomatis terbentuk: debit Akun Piutang Usaha, kredit Akun Pendapatan (+ akun biaya tambahan/PPN kalau diisi) — sesuai yang tadi terlihat di panel preview.
- Invoice ini sekarang bisa dibayar lewat [terima-pembayaran-ar.md](terima-pembayaran-ar.md).

## Kesalahan Umum

- **Bingung kenapa field Akun Piutang/Akun Pendapatan tidak bisa diedit** — memang sengaja dikunci ke Default Account Settings supaya tidak salah pilih akun; kalau akunnya perlu diganti, ubah di pengaturan default account, bukan di form ini.
- **Lupa centang PPN padahal transaksinya kena pajak** — checkbox ini cuma muncul kalau pengaturan pajak sudah diaktifkan di `/settings/charges` DAN harus dicentang manual tiap invoice, tidak otomatis dicentang.
- **Menganggap form ini bisa dipakai untuk mencatat penjualan yang sudah lewat Sales Order/Goods Issue** — itu duplikat. Invoice dari alur Sales Order/Goods Issue sudah otomatis terbentuk di tempat lain.
