# Retur Barang ke Supplier (AP)

## Kapan Melakukan Ini

Saat barang yang diterima dari supplier bermasalah (rusak/salah kirim/kualitas tidak sesuai). Ada **3 opsi berbeda** tergantung bagaimana penyelesaiannya disepakati dengan supplier — pilih salah satu, bukan campur ketiganya untuk item yang sama.

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

### Opsi C — Tulis-jadi-Beban

Dipakai kalau supplier **menolak kompensasi sama sekali** — barang rusak jadi kerugian yang ditanggung sendiri.

1. Di detail bill, klik tombol **Write-off** (kerugian barang rusak).
2. Baca catatan: **Utang Usaha bill ini tetap penuh** — tidak ada pengurangan tagihan maupun barang pengganti.
3. Isi **Tanggal**, lalu **Qty Write-off** per item.
4. Klik **Simpan Write-off**.

## Hasil Akhir

- **Opsi A**: jurnal debit Utang Usaha, kredit Akun Persediaan/Beban terkait. Kalau nominal retur melebihi sisa outstanding bill (bill sudah lunas), kelebihannya otomatis jadi **Piutang Retur Supplier** (bisa direfund tunai lewat tombol **Refund Tunai Piutang Retur Supplier**).
- **Opsi B**: jurnal murni reklasifikasi Akun Persediaan (debit barang masuk, kredit barang keluar) — tidak menyentuh Utang Usaha.
- **Opsi C**: jurnal debit Akun Beban Kerugian Barang Rusak, kredit Akun Persediaan — tidak menyentuh Utang Usaha.
- Ketiga opsi berbagi kuota qty yang sama per item (satu item yang sudah diklaim penuh lewat salah satu opsi tidak bisa diklaim lagi lewat opsi lain).

## Kesalahan Umum

- **Salah pilih opsi untuk kesepakatan yang sebenarnya terjadi** — cek dulu hasil negosiasi dengan supplier (uang kembali vs barang pengganti vs tidak ada kompensasi) sebelum memilih tombol; ketiganya punya efek jurnal yang sangat berbeda ke Utang Usaha.
- **Mengira Opsi B/C mengurangi Utang Usaha** — tidak, cuma Opsi A yang menyentuh Utang Usaha; Opsi B dan C murni soal stok/kerugian.
- **Mencoba klaim qty lebih dari sisa yang tersedia** — qty dibatasi gabungan dari ketiga opsi; kalau item sudah diklaim penuh lewat kombinasi opsi sebelumnya, form akan menampilkan "sudah diklaim penuh".
