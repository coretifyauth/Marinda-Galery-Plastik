# Retur Barang ke Supplier (AP)

## Kapan Melakukan Ini

Saat barang yang diterima dari supplier bermasalah (rusak/salah kirim/kualitas tidak sesuai), atau barangnya **kurang dari yang tertagih** (mis. tagihan 100 pcs, yang datang cuma 70 pcs). Ada **2 opsi berbeda** tergantung bagaimana penyelesaiannya disepakati dengan supplier — pilih salah satu, bukan campur keduanya untuk item yang sama.

Kalau supplier **menolak kompensasi sama sekali** (tidak mau mengurangi tagihan, tidak mau kirim pengganti), barang rusak itu dicatat lewat **Stock Opname** (penyesuaian stok fisik), bukan lewat halaman ini — lihat panduan Stock Opname.

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Bill-nya sudah ada dan belum dibatalkan.
- Tahu opsi penyelesaian mana yang disepakati dengan supplier untuk item ini.

## Langkah-Langkah

### Opsi A — Barang Kurang / Dikembalikan (Kurangi Utang)

Dipakai kalau supplier setuju mengurangi tagihan sebesar barang yang kurang atau dikembalikan. Kalau tagihannya **sudah lunas**, tidak ada utang yang dikurangi — nilainya jadi **saldo kita di supplier** (uang kita yang masih ada di supplier).

1. Buka detail bill (`/ap-bills/[id]`), buka tab **Barang Kurang / Retur**, klik tombol **Barang Kurang / Dikembalikan**.
2. Baca catatan: kalau bill ini dari Goods Receipt, isi qty per item — stok otomatis berkurang dan Utang Usaha dikurangi sebesar **cost fisik barang** (bukan angka yang diketik manual). Kalau bill ini bukan dari GRN, isi **Nominal Retur** manual.
3. Kalau bill punya lebih dari 1 kategori debit, pilih **Akun Persediaan/Beban** yang mana yang diretur.
4. Isi **Tanggal Retur**, lalu untuk bill dari GRN isi qty per item **per satuan** (mis. 1 dus dan 3 pcs di kolom masing-masing). Sistem menjumlahkannya ke satuan dasar sendiri, dan batas yang masih boleh diklaim ditampilkan dalam satuan campuran ("Maks 1 dus, 4 pcs") — tidak perlu konversi manual.
5. Cek kartu **Nilai Barang Kurang / Dikembalikan** di sisi kanan — di situ terlihat berapa yang **mengurangi utang** dan berapa yang **jadi saldo di supplier**.
6. Klik **Simpan**.

### Opsi B — Tukar Barang

Dipakai kalau supplier mengganti barang rusak dengan barang baik, **tanpa mengubah nilai tagihan sama sekali**.

1. Di detail bill, klik tombol **Tukar Barang**.
2. Baca catatan: ini **murni reklasifikasi stok** (barang rusak keluar, barang baik masuk) — Utang Usaha bill ini tetap penuh, tidak disentuh sama sekali.
3. Isi **Tanggal**, lalu **Qty Tukar** per item.
4. Klik **Simpan Tukar Barang**.

## Hasil Akhir

- **Opsi A**: jurnal debit Utang Usaha, kredit Akun Persediaan/Beban terkait. Kalau nominal retur melebihi sisa outstanding bill (bill sudah lunas), kelebihannya otomatis jadi **saldo di supplier** (akun Piutang Retur Supplier) dan muncul di tabel **Saldo di Supplier (dari kelebihan retur)** di tab yang sama. Saldo itu bisa diminta kembali tunai lewat tombol **Minta Kembali Tunai**, dan terlihat juga di tab **Saldo di Supplier** pada detail supplier. Saat ini saldo kelebihan retur hanya bisa diminta kembali tunai, belum bisa dipakai memotong tagihan lain.
- **Opsi B**: jurnal murni reklasifikasi Akun Persediaan (debit barang masuk, kredit barang keluar) — tidak menyentuh Utang Usaha.
- Kedua opsi berbagi kuota qty yang sama per item (satu item yang sudah diklaim penuh lewat salah satu opsi tidak bisa diklaim lagi lewat opsi lain).

## Kesalahan Umum

- **Salah pilih opsi untuk kesepakatan yang sebenarnya terjadi** — cek dulu hasil negosiasi dengan supplier (uang kembali vs barang pengganti) sebelum memilih tombol; keduanya punya efek jurnal yang berbeda ke Utang Usaha.
- **Mengira Opsi B mengurangi Utang Usaha** — tidak, cuma Opsi A yang menyentuh Utang Usaha; Opsi B murni soal stok.
- **Mencoba klaim qty lebih dari sisa yang tersedia** — qty dibatasi gabungan dari kedua opsi; kalau item sudah diklaim penuh lewat kombinasi opsi sebelumnya, form akan menampilkan "sudah diklaim penuh".
- **Mencari tombol Write-off/Tulis-jadi-Beban di halaman ini** — sudah tidak ada. Barang yang supplier tolak kompensasi sama sekali sekarang dicatat lewat Stock Opname, bukan dari halaman detail bill.
