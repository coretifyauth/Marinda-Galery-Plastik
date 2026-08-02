# Financial Reports — Struktur Data

Fase 7. Konsep bisnisnya ada di `docs/domain/financial-reports.md`. Skenario nyata (angka tervalidasi lintas 6 fase): `docs/story/financial-reports.md`. Detail teknis: `memory/architecture/data/financial-reports-schema.md`.

## Peta Data (ERD) — Gak Ada Tabel Baru

Beda dari semua fase sebelumnya: Financial Reports **gak menambah satu tabel pun**. Empat laporannya (Trial Balance, Income Statement, Balance Sheet, Cash Flow) semuanya dihitung on-demand dari 3 tabel yang sudah ada sejak Fase 1 dan Fase 2:

| Tabel (sudah ada) | Peran di laporan ini |
|---|---|
| `accounts` | Sumber daftar akun, kategori, dan arah saldo normal (dipakai buat tahu tiap saldo akun ditambah atau dikurang) |
| `journal_entries` | Sumber tanggal transaksi — jadi dasar filter "per tanggal tertentu" (Trial Balance/Balance Sheet) atau "rentang tanggal" (Income Statement/Cash Flow) |
| `journal_lines` | Sumber angka debit/kredit mentah yang dijumlahkan per akun |

Laporan ini bisa dibayangkan sebagai **lapisan baca (read layer)** yang duduk di atas 3 tabel itu — bukan entity baru yang berdiri sendiri.

## Bagaimana Tiap Laporan Dihitung

1. **Trial Balance** — jumlahkan debit dan kredit tiap akun sampai tanggal tertentu, hasilnya saldo per akun di 1 titik waktu.
2. **Income Statement** — ambil akun Pendapatan dan Beban dari Trial Balance, tapi dibatasi rentang tanggal (bukan sampai tanggal tertentu doang) — Laba Bersih = Pendapatan dikurangi Beban. Khusus laporan ini, transaksi jurnal penutup (hasil Tutup Buku, lihat di bawah) sengaja **dikeluarkan** dari perhitungan — supaya lihat ulang Laba Rugi periode yang udah ditutup tetap nunjukin angka historis, bukan 0 (detail: bagian "Tutup Buku" di bawah).
3. **Balance Sheet** — ambil akun Aset, Liabilitas, Ekuitas dari Trial Balance di 1 tanggal, ditambah 1 baris tambahan "Laba Ditahan" yang nilainya dihitung ulang dari Income Statement. Perhitungan ulang ini tetap dipakai meski Period Closing sekarang sudah ada (lihat bagian "Tutup Buku" di bawah) — begitu ada periode yang sudah ditutup, saldo Pendapatan/Beban yang tersisa di Trial Balance otomatis cuma mewakili periode yang masih berjalan (periode-periode sebelumnya sudah dinolkan beneran oleh proses tutup buku), jadi rumus yang sama tetap benar di kedua kondisi.
4. **Cash Flow** — bandingkan 2 Trial Balance (awal dan akhir periode) buat tahu perubahan saldo Piutang/Persediaan/Utang, dikombinasikan dengan Laba Bersih dari Income Statement dan Beban Penyusutan yang ditambahkan balik (karena penyusutan bukan transaksi kas beneran).

## Kenapa Bukan Tabel/View Database Baru

Datanya diambil apa adanya (baris transaksi yang relevan, difilter tanggal) lalu **dijumlahkan di kode aplikasi** — sama persis pola fitur "Ledger" yang sudah ada di halaman detail akun (`/accounts/[id]`), cuma sekarang dijalankan untuk semua akun sekaligus, bukan 1 akun. Gak ada logic tersembunyi di level database yang perlu dijaga lewat migration terpisah, dan gak bergantung ke fitur agregat khusus di sisi database (sempat dicoba, ternyata gak aktif secara default di project ini).

## Tutup Buku (Period Closing) — Satu-satunya Bagian yang Beneran Nambah Tabel

Beda dari 4 laporan di atas (murni baca), tutup buku itu **tindakan menulis** — mengubah data, bukan cuma menampilkannya. Ada 1 tabel baru: `period_closings`, daftar rentang tanggal yang sudah "disegel". Gak ada tabel "periode" dengan status terbuka/tertutup terpisah — sebuah tanggal dianggap "masih terbuka" kalau memang belum ada baris di `period_closings` yang mencakup tanggal itu.

**Cara kerja "Tutup Periode":**
1. Sistem menghitung ulang total Pendapatan dan Beban untuk rentang tanggal itu langsung dari data mentah (bukan menerima angka dari luar — supaya gak bisa "ditutup" dengan angka yang salah).
2. Semua akun Pendapatan dan Beban yang aktif di rentang itu dinolkan lewat 1 transaksi jurnal penutup, selisihnya (Laba atau Rugi bersih periode itu) dipindahkan ke akun Laba Ditahan.
3. Rentang tanggal itu dicatat sebagai "tertutup".

Setelahnya, **transaksi baru gak boleh lagi bertanggal masuk ke rentang yang sudah tertutup** — kalau ada transaksi yang ketinggalan, tetap dicatat, tapi dengan tanggal periode yang sedang berjalan sekarang, bukan dipaksa masuk ke tanggal lama (`docs/domain/general-ledger.md`).

**Aturan yang dijaga sistem:**
- Periode harus ditutup berurutan dan tanpa jeda — gak bisa loncat (tutup Maret duluan sebelum Februari) atau bolong (lupa nutup 1 bulan).
- Periode yang sudah ditutup **gak bisa dibuka lagi** — kalau ada kesalahan, koreksinya lewat transaksi baru di periode yang sedang berjalan, bukan membongkar kunci periode lama. Ini konsisten dengan prinsip "laporan yang sudah dipegang pihak luar gak boleh diam-diam berubah".
- Kalau suatu rentang tanggal ternyata gak punya transaksi Pendapatan/Beban sama sekali, rentang itu tetap bisa "ditutup" (buat menjaga urutan tetap bersambung) tanpa perlu bikin transaksi jurnal penutup apa pun.

**Kenapa lihat ulang Laba Rugi periode yang udah ditutup tetap benar (bukan 0):** transaksi jurnal penutup itu sendiri bertanggal di hari terakhir periode yang ditutup — kalau ikut dihitung pas laporan Income Statement dijalankan ulang buat rentang yang sama, dia bakal membatalkan balik saldo yang baru aja dinolkan (menolkan Pendapatan lagi jadi 0, dst). Ini pernah kejadian beneran (dicatat & sekarang sudah diperbaiki) — laporan Income Statement sekarang secara khusus mengabaikan transaksi jurnal penutup dari perhitungannya, jadi selalu menunjukkan angka historis asli, kapan pun dijalankan. Trial Balance dan Neraca sengaja TETAP memperhitungkan transaksi jurnal penutup — itu justru intinya, supaya saldo Pendapatan/Beban kumulatif yang ditampilkan beneran mencerminkan periode yang sudah dinolkan.

## Keterbatasan Saat Ini

- **Belum ada mekanisme "buka lagi" periode yang salah ditutup** — sengaja (lihat di atas), tapi konsekuensinya kesalahan penutupan gak bisa dibatalkan secara langsung.
- **Cash Flow metode Direct belum tersedia** — cuma metode Indirect (mulai dari Laba Bersih, dikoreksi balik) yang didukung, karena metode Direct butuh setiap transaksi kas dikategorikan asalnya (dari pelanggan/ke supplier/dst), yang belum ada mekanismenya.
- **Pengelompokan Investing vs Financing di Cash Flow masih manual** berdasarkan daftar akun yang diketahui (Utang Bank = Financing, Aset Tetap = Investing) — belum otomatis dari struktur data, jadi kalau ada jenis akun serupa baru harus diupdate manual.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat semua 4 laporan | Semua user yang sudah login — sama seperti hak akses tab Ledger di halaman akun individual, gak ada pembatasan tambahan karena laporan cuma menggabungkan data yang sudah bisa dilihat per-akun |
| Menutup periode (tutup buku) | Role `admin` atau `accountant` |
