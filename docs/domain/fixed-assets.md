# Fixed Assets — Penyusutan Aset Tetap

## Masalah yang Diselesaikan

CV Roti Barokah tahun 2025 beli 2 barang pakai pinjaman KUR (`docs/story/company-profile.md`): **oven tambahan** dan **motor** buat antar roti. Beda dari bahan baku (tepung/gula) yang habis sekali pakai lalu jadi HPP (`docs/domain/inventory.md`), oven dan motor **dipakai berulang bertahun-tahun**.

Kalau dicatat kayak beban biasa — nilai beli penuh langsung jadi Beban di bulan beli — Laporan Laba Rugi jadi ancur: rugi besar di bulan beli, padahal barangnya masih produktif dipakai bertahun-tahun ke depan. Modul ini nutup gap itu: menyebar biaya perolehan aset tetap ke sepanjang masa manfaatnya, bukan numpuk di satu periode.

## Prinsip Inti: Matching, Lagi

Sama akar prinsip kayak Inventory: **matching principle** — biaya diakui bersamaan dengan periode manfaat yang dihasilkannya, bukan bersamaan dengan kas keluar.

Bedanya sama Inventory: kalau Inventory nunggu **kejadian pemicu** (barang terjual) buat mengakui biaya, Fixed Assets nyebar biaya **berdasarkan waktu** (tiap bulan berjalan, tanpa perlu kejadian pemicu apapun) — karena manfaat oven/motor emang mengalir terus tiap bulan, bukan cuma pas 1 momen tertentu.

## Alur Akuntansi

**1. Akuisisi (beli aset)** — pertukaran aset ke aset, sama pola kayak beli bahan baku:

```
Aset Tetap (Oven)     15.000.000   (debit)
   Kas / Utang            15.000.000   (kredit)
```

**2. Penyusutan (tiap bulan, bukan sekali)** — di sinilah biaya benar-benar diakui, disebar per periode:

```
Beban Penyusutan Oven        250.000   (debit)
   Akumulasi Penyusutan Oven      250.000   (kredit)
```

**Kesalahpahaman umum yang wajib diluruskan**: sisi kredit BUKAN akun Aset Tetap itu sendiri. Sisi kredit adalah akun terpisah — **Akumulasi Penyusutan** — bukan pengurangan langsung ke akun Aset Tetap.

## Kenapa Butuh Akun Terpisah (Akumulasi Penyusutan), Bukan Kredit Langsung ke Aset

Tiga alasan:

1. **Histori nilai perolehan harus tetap utuh.** Akun Aset Tetap (Oven) saldo tetap Rp15.000.000 selamanya (sampai dijual/dibuang) — biar bisa ditelusur balik "beli berapa dulu". Kalau dikredit langsung tiap bulan, saldo akun Oven ikut turun dan histori nilai perolehan hilang.

2. **Nilai buku = 2 akun terpisah, ditampilkan berdampingan di Neraca**, bukan 1 akun yang nilainya berkurang:

```
Aset Tetap (Oven)              15.000.000
Akumulasi Penyusutan Oven       (3.000.000)   ← kontra-asset, saldo kredit, tampil sebagai pengurang
Nilai Buku Oven                 12.000.000
```

3. **Auditability** — bisa dijawab kapan pun "oven ini beli berapa tahun 2025?" langsung dari saldo akun Aset Tetap, tanpa perlu hitung mundur dari penyusutan yang udah jalan.

## Akun Kontra-Asset

Akumulasi Penyusutan adalah **akun kontra-asset** — konsep umum akun kontra dibahas penuh (definisi, contoh lintas kategori, simulasi dengan/tanpa kontra) di `docs/domain/chart-of-accounts.md` bagian "Akun Kontra". Ringkasnya: kategorinya tetap asset, tapi saldo normalnya **kredit** — kebalikan dari asset biasa yang normal_balance-nya debit. Ini pemakaian pertama konsep kontra di project ini — modul-modul sebelumnya (COA, GL, AR, AP, Inventory) semua akun asset-nya normal debit tanpa pengecualian.

**Dampak ke schema existing**: `accounts.normal_balance` di `coa-schema.md` adalah generated column yang derive otomatis dari `category` (`asset`/`expense` → selalu `debit`, tanpa pengecualian). Ini gak bisa nampung akun kontra-asset tanpa perubahan.

**Keputusan diambil (Opsi A)**: tambah kolom `accounts.is_contra` (boolean, default `false`), rumus generated column `normal_balance` ikut flag ini — kategori asset dengan `is_contra=true` jadi normal kredit, dst. `is_contra` juga masuk daftar field yang dikunci setelah akun kepakai transaksi (`published` field-lock). DDL final + migration: `docs/architecture/fixed-assets-schema.md` (`0014_fixed_assets_schema.sql`) — sudah diterapkan ke instance Supabase, UI (`/fixed-assets`) sudah dibangun & dites.

## Metode Penyusutan: Garis Lurus & Saldo Menurun

Scope Fase 6 mencakup **2 metode**: Garis Lurus (Straight-Line) dan Saldo Menurun (Declining Balance). Ditentukan **per aset** (`fixed_assets.depreciation_method`), bukan global — 1 CV bisa punya oven yang disusutkan garis lurus dan motor yang disusutkan saldo menurun sekaligus.

Istilah dasar (berlaku kedua metode):
- **Nilai perolehan (cost)** — harga beli + biaya buat siap pakai (ongkir, instalasi)
- **Umur manfaat (useful life)** — estimasi berapa lama aset dipakai (dalam tahun/bulan)
- **Nilai residu (salvage value)** — estimasi nilai jual kalau udah gak dipakai (sering Rp0 buat aset UMKM kecil)
- **Nilai buku (net book value)** — `Nilai Perolehan - Akumulasi Penyusutan`, ini yang muncul di Neraca, bukan nilai perolehan mentah

### Garis Lurus (Straight-Line)

Penyusutan **sama besar tiap periode**, dihitung sekali di awal:

```
Penyusutan per tahun = (Nilai Perolehan - Nilai Residu) / Umur Manfaat
```

**Contoh:** Oven tambahan, nilai perolehan Rp15.000.000, umur manfaat 5 tahun, nilai residu Rp0.
- Penyusutan per tahun: `15.000.000 / 5 = Rp3.000.000` → per bulan `Rp250.000`
- Setelah 1 tahun: Akumulasi = Rp3.000.000, Nilai buku = Rp12.000.000
- Setelah 5 tahun (habis umur manfaat): Nilai buku = Rp0, aset **tetap tercatat** (gak dihapus) sampai beneran dijual/dibuang (disposal — scope terpisah, belum dibahas).

Cocok buat aset yang manfaatnya rata tiap tahun (gedung, oven yang dipakai stabil).

### Saldo Menurun (Declining Balance)

Penyusutan dihitung dari **persentase tetap dikali nilai buku SISA** (bukan nilai perolehan awal) — karena nilai buku makin ngecil tiap tahun, angka penyusutan ikut ngecil (beda dari garis lurus yang statis):

```
Penyusutan tahun ini = Nilai Buku Awal Tahun × Tarif Persentase
```

**Contoh:** Motor, nilai perolehan Rp24.000.000, nilai residu Rp2.400.000, tarif 40%/tahun.

| Tahun | Nilai Buku Awal | Penyusutan | Akumulasi | Nilai Buku Akhir |
|---|---|---|---|---|
| 1 | 24.000.000 | 24.000.000 × 40% = 9.600.000 | 9.600.000 | 14.400.000 |
| 2 | 14.400.000 | 14.400.000 × 40% = 5.760.000 | 15.360.000 | 8.640.000 |
| 3 | 8.640.000 | 8.640.000 × 40% = 3.456.000 | 18.816.000 | 5.184.000 |
| 4 | 5.184.000 | dipotong biar pas residu: 2.784.000 | 21.600.000 | 2.400.000 |

**Catatan teknis penting:** tahun terakhir sering butuh **penyesuaian manual** (dipotong, kayak tahun 4 di atas) biar nilai buku berhenti pas di nilai residu — kalau dibiarin pakai rumus polos, bisa jadi lewat/kurang dari residu. RPC `post_depreciation` wajib cek: kalau hasil hitung bikin akumulasi lewat cap `(Nilai Perolehan - Nilai Residu)`, potong otomatis ke sisa yang tersedia (constraint #1 di bawah).

Cocok buat aset yang cepat kehilangan nilai/manfaat pas masih baru (kendaraan, elektronik) — beda dari garis lurus yang mengasumsikan manfaat rata.

### Dampak ke Schema (dari 2 metode)

`fixed_assets` butuh kolom tambahan:
```
depreciation_method   enum('straight_line','declining_balance')  not null default 'straight_line'
depreciation_rate     numeric nullable   -- wajib keisi kalau declining_balance, harus null kalau straight_line
```
`depreciation_entries` **gak berubah** — `amount` udah disimpan eksplisit per baris (bukan re-derive dari formula), jadi otomatis nampung angka penyusutan yang beda-beda tiap tahun (declining balance) tanpa perlu struktur tambahan.

Metode ketiga (unit produksi) di luar scope Fase 6 ini — lihat "Belum Termasuk".

## Constraint Wajib

**1. Penyusutan gak boleh melebihi (Nilai Perolehan - Nilai Residu)**
Akumulasi Penyusutan punya batas atas. Kalau posting penyusutan bulanan diteruskan lewat batas ini, nilai buku bisa jadi negatif — gak masuk akal secara akuntansi (aset gak mungkin bernilai negatif). Berlaku ke kedua metode — declining balance malah lebih rawan kena batas ini di periode-periode akhir (lihat catatan teknis di contoh saldo menurun), jadi cap ini wajib dicek tiap posting, bukan cuma diasumsikan aman kayak straight-line.

**2. Aset Tetap tercatat, gak berubah, sampai disposal**
Beda dari saldo Persediaan yang naik-turun tiap transaksi, saldo akun Aset Tetap per unit aset tetap konstan dari akuisisi sampai disposal — hanya Akumulasi Penyusutan yang bergerak.

**3. Tiap posting penyusutan tertelusur ke aset & periode yang jelas**
Sama invarian traceability modul lain — harus jelas penyusutan bulan mana, buat aset yang mana, biar gak dobel posting atau kelewat.

## Common Mistakes

- Mencatat pembelian aset tetap langsung sebagai Beban penuh di bulan beli — melanggar matching principle, sama akar kesalahan kayak "membeli = berbiaya" di Inventory.
- Mengkredit langsung akun Aset Tetap saat posting penyusutan bulanan — harusnya kredit ke akun terpisah, Akumulasi Penyusutan. Histori nilai perolehan jadi hilang kalau ini terjadi.
- Lupa nilai residu — penyusutan dihitung kayak residu-nya Rp0 padahal ada, bikin nilai buku turun lebih cepat dari seharusnya (bisa sampai negatif).
- Menyusutkan lewat batas nilai perolehan (total Akumulasi Penyusutan melebihi Nilai Perolehan - Nilai Residu).

## Belum Termasuk (Scope Debt)

- Disposal aset (dijual/dibuang sebelum atau sesudah habis umur manfaat) — belum dibahas.
- Metode penyusutan **Unit Produksi** — beda paling jauh dari 2 metode yang masuk scope: butuh data pemakaian aktual eksternal tiap periode (KM motor, jumlah batch produksi oven), bukan cuma dihitung dari waktu berjalan. Berpotensi coupling ke `production_orders` (Inventory). Ditunda karena straight-line + declining balance udah cukup buat kebutuhan CV Roti Barokah.
- Revaluasi aset (penyesuaian nilai wajar di luar penyusutan rutin).
- Ganti metode di tengah umur manfaat aset (analog "gonta-ganti metode costing" di Inventory — butuh proses revaluasi formal, bukan update field biasa).
