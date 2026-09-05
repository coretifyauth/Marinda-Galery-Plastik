# Retur Barang ke Supplier (AP)

## Kapan Melakukan Ini

Saat barang yang diterima dari supplier bermasalah (rusak/salah kirim/kualitas tidak sesuai). Ada **2 opsi berbeda** tergantung bagaimana penyelesaiannya disepakati dengan supplier — pilih salah satu, bukan campur keduanya untuk item yang sama.

Kalau supplier **menolak kompensasi sama sekali** (tidak mau mengurangi tagihan, tidak mau kirim pengganti), barang rusak itu dicatat lewat **Stock Opname** (penyesuaian stok fisik), bukan lewat halaman ini — lihat panduan Stock Opname.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Bill-nya sudah ada dan belum dibatalkan.
- Tahu opsi penyelesaian mana yang disepakati dengan supplier untuk item ini.

## Langkah-Langkah

### Opsi A — Retur, Kurangi Utang

Dipakai kalau supplier setuju mengurangi tagihan sebesar barang yang dikembalikan.

1. Buka detail bill (`/ap-bills/[id]`), klik tombol **Retur**.
2. Baca catatan: kalau bill ini dari Goods Receipt, isi qty per item — stok otomatis berkurang dan Utang Usaha dikurangi sebesar **cost fisik barang** (bukan angka yang diketik manual). Kalau bill ini bukan dari GRN, isi **Nominal Retur** manual.
3. Kalau bill punya lebih dari 1 kategori debit, pilih **Akun Persediaan/Beban** yang mana yang diretur.
4. Isi **Tanggal Retur**, lalu untuk bill dari GRN isi **Qty Retur** per item.
5. Klik **Simpan Retur**.

### Opsi B — Tukar Barang

Dipakai kalau supplier mengganti barang rusak dengan barang baik, **tanpa mengubah nilai tagihan sama sekali**.

1. Di detail bill, klik tombol **Tukar Barang**.
2. Baca catatan: ini **murni reklasifikasi stok** (barang rusak keluar, barang baik masuk) — Utang Usaha bill ini tetap penuh, tidak disentuh sama sekali.
3. Isi **Tanggal**, lalu **Qty Tukar** per item.
4. Klik **Simpan Tukar Barang**.

## Hasil Akhir

- **Opsi A**: jurnal debit Utang Usaha, kredit Akun Persediaan/Beban terkait. Kalau nominal retur melebihi sisa outstanding bill (bill sudah lunas), kelebihannya otomatis jadi **Piutang Retur Supplier** (bisa direfund tunai lewat tombol **Refund Tunai Piutang Retur Supplier**).
- **Opsi B**: jurnal murni reklasifikasi Akun Persediaan (debit barang masuk, kredit barang keluar) — tidak menyentuh Utang Usaha.
- Kedua opsi berbagi kuota qty yang sama per item (satu item yang sudah diklaim penuh lewat salah satu opsi tidak bisa diklaim lagi lewat opsi lain).

## Kesalahan Umum

- **Salah pilih opsi untuk kesepakatan yang sebenarnya terjadi** — cek dulu hasil negosiasi dengan supplier (uang kembali vs barang pengganti) sebelum memilih tombol; keduanya punya efek jurnal yang berbeda ke Utang Usaha.
- **Mengira Opsi B mengurangi Utang Usaha** — tidak, cuma Opsi A yang menyentuh Utang Usaha; Opsi B murni soal stok.
- **Mencoba klaim qty lebih dari sisa yang tersedia** — qty dibatasi gabungan dari kedua opsi; kalau item sudah diklaim penuh lewat kombinasi opsi sebelumnya, form akan menampilkan "sudah diklaim penuh".
- **Mencari tombol Write-off/Tulis-jadi-Beban di halaman ini** — sudah tidak ada. Barang yang supplier tolak kompensasi sama sekali sekarang dicatat lewat Stock Opname, bukan dari halaman detail bill.
