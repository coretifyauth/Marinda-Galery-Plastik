# Retur Barang ke Supplier (AP)

## Kapan Melakukan Ini

Saat barang yang diterima dari supplier bermasalah (rusak/salah kirim/kualitas tidak sesuai), atau barangnya **kurang dari yang tertagih** (mis. tagihan 100 pcs, yang datang cuma 70 pcs). Ada **2 opsi berbeda** tergantung bagaimana penyelesaiannya disepakati dengan supplier — pilih salah satu, bukan campur keduanya untuk item yang sama.

Kalau supplier **menolak kompensasi sama sekali** (tidak mau mengurangi tagihan, tidak mau kirim pengganti), barang rusak itu dicatat lewat **Stock Opname** (penyesuaian stok fisik), bukan lewat halaman ini — lihat panduan Stock Opname.

> Retur dicatat padahal salah input (barangnya tidak benar-benar dikembalikan)? Jangan dibiarkan: batalkan lewat **Batalkan Retur**, lihat [koreksi-salah-input.md](koreksi-salah-input.md) bagian D.

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

### Tukar Barang (sudah dicabut)

Fitur **Tukar Barang** (supplier mengganti barang rusak dengan barang baik tanpa mengubah tagihan) **dicabut 2026-11-02** dan tombolnya sudah tidak ada. Kalau supplier mengganti barang, catat lewat retur di atas (kalau utang dikurangi) atau Stock Opname, dan catat barang pengganti yang datang sebagai barang masuk dari tagihan yang sesuai.

## Hasil Akhir

- **Opsi A**: jurnal debit Utang Usaha, kredit Akun Persediaan/Beban terkait. Kalau nominal retur melebihi sisa outstanding bill (bill sudah lunas), kelebihannya otomatis jadi **saldo di supplier** (akun Piutang Retur Supplier) dan muncul di tabel **Saldo di Supplier (dari kelebihan retur)** di tab yang sama. Saldo itu bisa diminta kembali tunai lewat tombol **Minta Kembali Tunai**, dan terlihat juga di tab **Saldo di Supplier** pada detail supplier. Saat ini saldo kelebihan retur hanya bisa diminta kembali tunai, belum bisa dipakai memotong tagihan lain.

## Kesalahan Umum

- **Mencoba klaim qty lebih dari sisa yang tersedia** — qty dibatasi total qty yang diterima dikurangi yang sudah diretur; kalau item sudah diklaim penuh, form akan menampilkan "sudah diklaim penuh".
- **Mencari tombol Write-off/Tulis-jadi-Beban di halaman ini** — sudah tidak ada. Barang yang supplier tolak kompensasi sama sekali sekarang dicatat lewat Stock Opname, bukan dari halaman detail bill.
