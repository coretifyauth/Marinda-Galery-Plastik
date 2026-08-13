# Penomoran Dokumen Otomatis — Struktur Data

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi |
|---|---|
| Daftar Jenis Dokumen | Master 29 jenis dokumen transaksional di seluruh sistem, masing-masing dengan kode singkat (prefix) sendiri — contoh AP Bill = `APB`, AR Invoice = `ARI`. |
| Penghitung Nomor | Menyimpan angka urutan terakhir yang sudah dipakai, per jenis dokumen per tahun. Sumber dari nomor berikutnya yang akan diberikan. |

## Generate Nomor Otomatis

**Peta Data (ERD)**
- Daftar Jenis Dokumen: 1 baris per jenis dokumen (mis. AP Bill, AR Invoice, Purchase Order) — nama singkat, kode prefix, label.
- Penghitung Nomor: 1 baris per kombinasi jenis dokumen + tahun — angka urutan terakhir yang sudah dipakai.

**Alur Teknis**
- Simpan dokumen → sistem cari kode prefix jenis dokumen itu → naikkan angka urutan tahun berjalan sebanyak 1 → format jadi `PREFIX-TAHUN-00001` → nomor itu dipakai sebagai Nomor Dokumen final.

**Aturan Bisnis → Data**
- "Nomor gak boleh dobel" dijaga karena tiap kombinasi jenis dokumen + tahun cuma boleh punya 1 baris penghitung, dan kenaikannya dilakukan sebagai 1 operasi atomik (aman walau 2 transaksi tersimpan bersamaan).
- "Reset tiap tahun" dijaga karena tahun adalah bagian dari kunci baris penghitung — tahun baru otomatis mulai dari angka urutan 0 lagi.

**Interaksi Antar Tabel**
- Penghitung Nomor merujuk ke Daftar Jenis Dokumen (tiap baris penghitung harus jenis dokumen yang memang terdaftar).

## AP Bill — Nomor Nota Supplier

**Peta Data (ERD)**
- Tabel AP Bill dapat 1 kolom baru: Nomor Nota Supplier (teks bebas, boleh kosong).

**Alur Teknis**
- Saat input AP Bill, user isi Nomor Nota Supplier secara manual (opsional) — beda dari Nomor Dokumen yang otomatis dari sistem.

**Aturan Bisnis → Data**
- Nomor asli dari nota supplier gak boleh tertimpa nomor otomatis sistem — makanya disimpan di kolom terpisah, bukan menggantikan Nomor Dokumen.

**Interaksi Antar Tabel**
- Tetap di tabel AP Bill yang sudah ada — gak ada tabel baru untuk bagian ini.
