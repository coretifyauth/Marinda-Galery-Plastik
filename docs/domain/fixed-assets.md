# Fixed Assets — Penyusutan Aset Tetap

## Masalah yang Diselesaikan

Sebagian barang yang dibeli usaha bukan buat dijual lagi atau habis sekali pakai (beda dari bahan baku, lihat `docs/domain/inventory.md`) — barang kayak mesin produksi, kendaraan operasional, atau peralatan kerja **dipakai berulang bertahun-tahun**.

Kalau dicatat kayak beban biasa — nilai beli penuh langsung jadi Beban di bulan beli — Laporan Laba Rugi jadi ancur: rugi besar di bulan beli, padahal barangnya masih produktif dipakai bertahun-tahun ke depan. Modul ini nutup gap itu: menyebar biaya perolehan aset tetap ke sepanjang masa manfaatnya, bukan numpuk di satu periode.

## Konsep Inti

Prinsipnya sama akar kayak Inventory: **matching principle** — biaya diakui bersamaan dengan periode manfaat yang dihasilkannya, bukan bersamaan dengan kas keluar. Bedanya: kalau Inventory nunggu **kejadian pemicu** (barang terjual) buat mengakui biaya, Fixed Assets nyebar biaya **berdasarkan waktu** (tiap periode berjalan, tanpa perlu kejadian pemicu apapun) — karena manfaat aset itu mengalir terus tiap periode, bukan cuma pas 1 momen tertentu.

- **Aset Tetap** — satu unit barang fisik yang dipakai berulang (bukan kategori/kelompok barang). Tiap unit dicatat sendiri-sendiri, dengan nilai perolehan, estimasi umur manfaat, estimasi nilai residu, dan metode penyusutannya masing-masing (lihat submodule "Metode Penyusutan").
- **Akuisisi (beli aset)** — pertukaran aset ke aset, sama pola kayak beli bahan baku:
  ```
  Debit Aset Tetap
    Kredit Kas/Utang
  ```
  sejumlah nilai perolehan (harga beli + biaya bikin siap pakai, kayak ongkir/instalasi). Dicatat sebagai transaksi jurnal umum biasa, bukan proses khusus — yang dicatat lewat mekanisme modul ini cuma data masternya (nilai, umur manfaat, metode, akun-akun terkait).
- **Penyusutan (tiap periode, bukan sekali)** — di sinilah biaya benar-benar diakui, disebar per periode:
  ```
  Debit Beban Penyusutan
    Kredit Akumulasi Penyusutan
  ```
  Dilakukan tiap periode berjalan (biasanya bulanan) selama umur manfaat aset, sampai nilai buku mentok di nilai residu.
- **Kesalahpahaman umum yang wajib diluruskan**: sisi kredit penyusutan BUKAN akun Aset Tetap itu sendiri. Sisi kredit adalah akun terpisah — **Akumulasi Penyusutan** — bukan pengurangan langsung ke akun Aset Tetap.

**Kenapa butuh akun terpisah (Akumulasi Penyusutan), bukan kredit langsung ke Aset** — tiga alasan:
1. **Histori nilai perolehan harus tetap utuh.** Akun Aset Tetap saldonya tetap sebesar nilai perolehan selamanya (sampai dijual/dibuang) — biar bisa ditelusur balik "beli berapa dulu". Kalau dikredit langsung tiap periode, saldo akun Aset ikut turun dan histori nilai perolehan hilang.
2. **Nilai buku = 2 akun terpisah, ditampilkan berdampingan di Neraca**, bukan 1 akun yang nilainya berkurang — Aset Tetap (nilai perolehan) dikurangi Akumulasi Penyusutan (kontra-asset, saldo kredit, tampil sebagai pengurang) menghasilkan Nilai Buku.
3. **Auditability** — bisa dijawab kapan pun "aset ini beli berapa dulu?" langsung dari saldo akun Aset Tetap, tanpa perlu hitung mundur dari penyusutan yang udah jalan.

**Akun Kontra-Asset** — Akumulasi Penyusutan adalah akun kontra-asset: kategorinya tetap asset, tapi saldo normalnya **kredit**, kebalikan dari asset biasa yang normal debit. Konsep umum akun kontra (definisi, contoh lintas kategori, simulasi dengan/tanpa kontra) dibahas penuh di `docs/domain/chart-of-accounts.md` bagian "Akun Kontra". Ini pemakaian pertama konsep kontra di project ini — modul-modul sebelumnya (COA, GL, AR, AP, Inventory) semua akun asset-nya normal debit tanpa pengecualian.

**Constraint Wajib**
- **Penyusutan gak boleh melebihi (Nilai Perolehan - Nilai Residu).** Akumulasi Penyusutan punya batas atas — kalau posting penyusutan diteruskan lewat batas ini, nilai buku bisa jadi negatif, gak masuk akal secara akuntansi (aset gak mungkin bernilai negatif).
- **Aset Tetap tercatat, gak berubah, sampai pelepasan.** Beda dari saldo Persediaan yang naik-turun tiap transaksi, saldo akun Aset Tetap per unit aset konstan dari akuisisi sampai aset itu dijual/dibuang — cuma Akumulasi Penyusutan yang bergerak. Pelepasan aset (penjualan/pembuangan/kehilangan) dibahas di submodule "Disposal Aset Tetap" di bawah.
- **Tiap posting penyusutan tertelusur ke aset & periode yang jelas** — sama invarian traceability modul lain, harus jelas penyusutan periode mana buat aset yang mana, biar gak dobel posting atau kelewat.

**Common Mistakes**
- Mencatat pembelian aset tetap langsung sebagai Beban penuh di bulan beli — melanggar matching principle, sama akar kesalahan kayak "membeli = berbiaya" di Inventory.
- Mengkredit langsung akun Aset Tetap saat posting penyusutan — harusnya kredit ke akun terpisah, Akumulasi Penyusutan. Histori nilai perolehan jadi hilang kalau ini terjadi.
- Lupa nilai residu — penyusutan dihitung kayak residu-nya nol padahal ada, bikin nilai buku turun lebih cepat dari seharusnya (bisa sampai negatif).
- Menyusutkan lewat batas nilai perolehan (total Akumulasi Penyusutan melebihi Nilai Perolehan - Nilai Residu).

### Metode Penyusutan (Garis Lurus & Saldo Menurun)

**Cara Kerja**
- Ditentukan **per aset**, bukan satu metode buat semua — 1 usaha bisa punya aset yang disusutkan Garis Lurus dan aset lain yang disusutkan Saldo Menurun sekaligus.
- Istilah dasar (berlaku kedua metode): **nilai perolehan (cost)** — harga beli + biaya bikin siap pakai; **umur manfaat (useful life)** — estimasi berapa lama aset dipakai; **nilai residu (salvage value)** — estimasi nilai jual kalau udah gak dipakai, sering nol buat aset UMKM kecil; **nilai buku (net book value)** — Nilai Perolehan dikurangi Akumulasi Penyusutan, ini yang muncul di Neraca, bukan nilai perolehan mentah.
- **Garis Lurus (Straight-Line)** — penyusutan sama besar tiap periode, dihitung dari `(Nilai Perolehan - Nilai Residu) / Umur Manfaat`. Cocok buat aset yang manfaatnya rata tiap periode (gedung, mesin yang dipakai stabil).
- **Saldo Menurun (Declining Balance)** — penyusutan dihitung dari persentase tetap dikali **nilai buku sisa** (bukan nilai perolehan awal): `Nilai Buku Awal Periode × Tarif Persentase`. Karena nilai buku makin ngecil tiap periode, angka penyusutan ikut ngecil — beda dari Garis Lurus yang statis. Cocok buat aset yang cepat kehilangan nilai/manfaat pas masih baru (kendaraan, elektronik).
- **Periode terakhir umur manfaat sering butuh penyesuaian manual** (dipotong) biar nilai buku berhenti pas di nilai residu — kalau dibiarin pakai rumus polos, Saldo Menurun bisa bikin akumulasi lewat/kurang dari residu. Proses posting penyusutan wajib cek: kalau hasil hitung bikin akumulasi lewat batas (Nilai Perolehan - Nilai Residu), potong otomatis ke sisa yang tersedia.
- Metode ketiga, **Unit Produksi** (penyusutan berdasarkan pemakaian aktual, misal jam mesin/jarak tempuh), belum masuk scope — beda paling jauh dari 2 metode di atas karena butuh data pemakaian aktual dari luar modul ini (misal jumlah batch produksi, jarak tempuh kendaraan), berpotensi terhubung ke modul produksi di Inventory. Belum dibangun karena Garis Lurus + Saldo Menurun dinilai udah cukup buat kebutuhan sekarang. Belum ada scope-debt file buat ini.
- **Ganti metode penyusutan di tengah umur manfaat aset** juga belum punya jalur resmi — analog "gonta-ganti metode costing" di Inventory, butuh proses **revaluasi aset** formal (penyesuaian nilai wajar di luar penyusutan rutin) biar histori penyusutan yang udah jalan gak jadi gak konsisten, bukan sekadar ubah data metode begitu aja. Revaluasi aset secara umum juga belum dibahas/dibangun di modul ini. Belum ada scope-debt file buat keduanya.

**Aturan Bisnis**
- Metode ditentukan per aset saat aset didaftarkan, bukan setting global.
- Tarif persentase wajib diisi kalau metode Saldo Menurun, dan wajib kosong kalau Garis Lurus.
- Begitu aset punya minimal satu riwayat penyusutan, metode & tarifnya terkunci — gak bisa diubah lagi tanpa proses revaluasi formal (yang belum dibangun).

**Skenario**
- Aset disusutkan Garis Lurus — penyusutan sama besar tiap periode sepanjang umur manfaat.
- Aset disusutkan Saldo Menurun — penyusutan mengecil tiap periode karena dihitung dari nilai buku sisa; periode terakhir dipotong manual biar nilai buku pas berhenti di nilai residu.

**Common Mistakes**
- Pakai rumus Saldo Menurun polos di periode terakhir tanpa penyesuaian — bisa bikin akumulasi penyusutan lewat atau kurang dari batas nilai residu.
- Menganggap metode penyusutan bisa diganti kapan saja kayak field biasa — begitu aset punya riwayat penyusutan, ganti metode butuh proses revaluasi formal, bukan update field langsung.

### Disposal Aset Tetap (Penjualan/Pembuangan/Kehilangan)

**Cara Kerja**
- Begitu aset tetap berhenti dipakai selamanya — dijual, dibuang/rusak total, atau hilang/dicuri — dicatat lewat proses **disposal**, bukan dihapus dari sistem. Aset & seluruh riwayat penyusutannya tetap ada buat ditelusur, cuma ditandai sudah "dilepas" per tanggal tertentu.
- Nilai Buku dihitung ulang saat disposal (Nilai Perolehan dikurangi Akumulasi Penyusutan yang sudah berjalan sampai tanggal itu), lalu dibandingkan dengan Nilai Jual (uang yang benar-benar diterima, nol kalau dibuang/hilang):
  ```
  Laba/Rugi Pelepasan = Nilai Jual - Nilai Buku
  ```
- Satu jurnal, sekali posting, 3-4 baris tergantung kasus:
  - Debit Akumulasi Penyusutan — nolin kontra-asetnya, sebesar akumulasi yang sudah berjalan.
  - Kredit Aset Tetap — nolin akun asetnya, sebesar nilai perolehan penuh.
  - Debit Kas/Bank — kalau ada uang masuk, sejumlah Nilai Jual. Gak ada baris ini kalau dibuang/hilang (Nilai Jual nol).
  - Baris penyeimbang: Kredit akun Pendapatan Lain-lain (kalau untung) atau Debit akun Rugi Pelepasan Aset Tetap (kalau rugi).
- Begitu aset di-disposal, gak bisa lagi diposting penyusutan buat aset itu — riwayat penyusutan yang sudah ada tetap kebaca, tapi periode setelah tanggal disposal gak relevan lagi (asetnya udah gak ada).

**Aturan Bisnis**
- Satu aset cuma bisa di-disposal sekali — all-or-nothing per unit fisik, konsisten sama prinsip "1 aset = 1 unit fisik" (gak ada disposal sebagian/parsial).
- Disposal gak bisa dibatalkan lewat edit/hapus biasa (immutability, sama pola Journal Entry & histori penyusutan) — koreksi lewat jurnal pembalik kalau ternyata salah catat.
- Tanggal disposal harus sama atau lebih baru dari tanggal penyusutan terakhir yang sudah diposting buat aset itu — gak masuk akal disposal duluan baru nyusutin belakangan.

**Skenario**
- Motor dijual Rp7 juta, nilai buku Rp6 juta → untung Rp1 juta, masuk Pendapatan Lain-lain.
- Motor dijual Rp4 juta, nilai buku Rp6 juta → rugi Rp2 juta, masuk Rugi Pelepasan Aset Tetap.
- Motor hilang/dicuri, nilai buku Rp6 juta, gak ada uang masuk sama sekali → rugi penuh Rp6 juta (seluruh nilai buku).

**Common Mistakes**
- Menghapus (delete) baris aset dari sistem begitu dijual/dibuang — harusnya di-disposal (ditandai + dijurnal), bukan dihapus, karena histori nilai perolehan & penyusutan tetap harus bisa ditelusur.
- Lupa nolin Akumulasi Penyusutan saat disposal — kalau cuma nolin akun Aset Tetap doang tanpa Akumulasi Penyusutan, saldonya nyangkut selamanya padahal asetnya udah gak ada.
- Menghitung laba/rugi dari Nilai Perolehan (harga beli mentah) bukan Nilai Buku — salah basis, harus dibandingkan ke Nilai Buku yang sudah dikurangi penyusutan berjalan.
