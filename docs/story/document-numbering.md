# Penomoran Dokumen Otomatis — Toko Plastik Makmur Jaya

Sebelumnya, tiap kali Pak Herman input AP Bill, AR Invoice, Purchase Order, dan sejenisnya, dia harus ngetik sendiri nomor rujukannya — kadang lupa formatnya, kadang ke-double sama nomor lain. Sekarang sistem yang nerbitin nomornya sendiri, otomatis, begitu dokumennya disimpan.

## Skenario 1 — AP Bill dari supplier (nomor internal + nomor nota asli)

PT Plastindo Jaya kirim ember plastik ke toko, sekalian nota fisik bertuliskan **"SP-0451"**. Pak Herman buka menu **AP Bills** → **Tambah AP Bill**:

1. Pilih supplier **PT Plastindo Jaya**.
2. Isi field **Nomor Nota Supplier**: `SP-0451` (ini field baru — isi manual, sesuai apa yang tertulis di nota fisik).
3. Isi tanggal bill, kategori beban/persediaan, nominal seperti biasa.
4. Field "Rujukan Dokumen" yang dulu ada di form **sudah gak ada lagi** — gak perlu diisi manual.
5. Klik **Simpan**.

Sistem generate Nomor Dokumen `APB-2026-00007` barengan proses simpan. Halaman detail bill menampilkan **keduanya**: Nomor Dokumen `APB-2026-00007` (identitas internal di sistem kita) dan Nomor Nota Supplier `SP-0451` (referensi kalau nanti perlu klarifikasi ke PT Plastindo Jaya — mereka gak kenal `APB-2026-00007`, yang mereka kenal ya nota mereka sendiri).

## Skenario 2 — AR Invoice ke pelanggan grosir (dokumen internal, 1 nomor saja)

Toko Kelontong Sumber Rejeki ambil barang, Pak Herman buka menu **AR Invoices** → **Tambah AR Invoice**:

1. Pilih customer **Toko Kelontong Sumber Rejeki**.
2. Isi tanggal invoice, item, kategori pendapatan, PPN kalau relevan.
3. Gak ada field nomor manual sama sekali — AR Invoice murni dokumen yang KITA terbitkan, gak ada "nota pihak luar" yang perlu direkam terpisah.
4. Klik **Simpan**.

Sistem generate `ARI-2026-00012`. Muncul di halaman detail invoice sebagai satu-satunya nomor rujukan dokumen ini — gak perlu field kedua kayak di AP Bill.

## Skenario 3 — Reset tahunan

Andaikan sampai akhir Desember 2026 sistem sudah menerbitkan `APB-2026-00042` sebagai AP Bill terakhir tahun itu. Begitu masuk 1 Januari 2027, AP Bill pertama yang dibuat dapat nomor `APB-2027-00001` — bukan lanjut `00043`. Urutan tahun sebelumnya tetap utuh di data lama, gak kesentuh.

## Kenapa ini penting buat cerita Toko Makmur Jaya

Dulu pembukuan Pak Herman di buku tulis, nomor nota sering bentrok atau kelupaan. Sekarang begitu bisnis makin besar (grosir + retail jalan bareng, banyak supplier & pelanggan), nomor dokumen yang rapi dan otomatis bikin gampang dicari lagi kalau ada sengketa atau butuh telusur balik ke transaksi tertentu — sekaligus tetap nyimpen jejak nomor nota asli dari supplier, gak hilang begitu saja ditelan nomor internal kita.
