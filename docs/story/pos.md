# Story — POS / Jualan Eceran: Toko Plastik Makmur Jaya

Konteks bisnis lengkap: `docs/story/company-profile.md` — baca itu dulu kalau belum. Konsep: `docs/domain/pos.md`. Struktur data & RPC: `memory/architecture/data/pos-schema.md`.

**Beda dari file story lain**: tujuan file ini bukan cuma ngerti konsepnya, tapi bener-bener **jalan-jalan di UI beneran** — buka app-nya, klik menu, isi field, klik tombol, cek hasilnya. Tiap bagian di bawah pola-nya: narasi singkat (kenapa ini kejadian di cerita toko Pak Herman) → langkah UI konkret → apa yang harus muncul di layar.

Dua app kepisah, dua login kepisah:
- **`apps/pos`** — kios kasir. Layar penuh, tanpa sidebar admin, cuma dipakai Mbak Rina (role `cashier`). Kalau dijalankan lokal biasanya di port sendiri (misal `localhost:3001` kalau `apps/erp` sudah pakai `3000`) — sesuaikan sama setup `dev` kamu.
- **`apps/erp`** — dipakai Pak Herman (role `admin`) buat lihat riwayat transaksi kios (`/pos-sales`), pembatalan, dan setup katalog biaya tambahan + pajak (`/settings/charges`).

Mbak Rina **gak punya akses sama sekali** ke `apps/erp` — role `cashier` cuma bisa lewat RPC `create_pos_sale`, gak ada insert langsung ke tabel finansial manapun (`memory/architecture/data/pos-schema.md`).

## 1. Mbak Rina Login ke Kios

Jam 8 pagi, Mbak Rina buka laptop kasir di ruko.

**UI:**
1. Buka `apps/pos` di browser (root URL langsung ke `/login` kalau belum ada sesi).
2. Halaman **"Masuk Kasir — Toko Plastik Makmur Jaya"** muncul — form 2 field: **Email** dan **Password**.
3. Isi email+password akun yang sudah dibuatkan Pak Herman sebelumnya (akun kasir gak bisa daftar sendiri di layar ini — teks kecil di bawah judul sudah bilang itu).
4. Klik tombol **Masuk**.
5. Berhasil → redirect ke `/` (halaman checkout). Kalau salah password, muncul pesan error merah di atas tombol.

## 2. Checkout — Pembelian Retail Tunai (12 Agustus 2026)

Ibu-ibu warga sekitar mampir beli perlengkapan dapur plastik buat rumah. Bayar tunai, gak ada relasi ke pelanggan grosir manapun.

**UI (halaman checkout, `apps/pos` `/`):**
1. Layar terbagi 2: kiri **grid katalog barang** (kartu per item: nama, harga per satuan, sisa stok), kanan **panel Keranjang**.
2. Katalog cuma nampilin barang `item_type = FINISHED_GOOD` yang punya harga jual (`item_units`) — jadi barang yang emang siap dijual ke pembeli, misalnya **Ember Plastik 10L** (Rp35.000), **Piring Plastik** (Rp30.000/pack isi 6), **Gelas Plastik** (Rp28.000/pack isi 6).
3. Klik kartu **Ember Plastik 10L** 2×. Tiap klik nambah qty di keranjang (kalau item belum ada di keranjang, klik pertama nambahin baris baru qty 1).
4. Klik kartu **Piring Plastik** 1×.
5. Di panel Keranjang, tiap baris ada tombol **−**/**+** buat ubah qty langsung (tombol **+** otomatis disabled kalau qty udah nyentuh stok tersedia — no-oversell dicek dari `qtyOnHand` yang di-load bareng katalog) dan tombol **✕** buat hapus baris.
6. Section **"Metode Bayar"** — klik tombol **Tunai** (default sudah kepilih, background gelap nandain aktif).
7. Section **"Pelanggan (opsional)"** — biarin di **"Walk-in (tanpa nama)"**, gak usah pilih apa-apa (pembeli retail beneran, bukan salah satu dari 3 pelanggan grosir di `company-profile.md`).
8. Cek ringkasan di bawah: Subtotal Barang = `2×35.000 + 1×30.000 = 100.000`. Belum ada Biaya Tambahan/PPN (belum diisi), jadi **Total = Rp100.000**.
9. Klik tombol besar **Checkout** di paling bawah.
10. Muncul pesan hijau **"Transaksi berhasil — total Rp100.000"**, keranjang otomatis kosong lagi, katalog di-refresh (stok Ember Plastik 10L & Piring Plastik berkurang sesuai qty yang barusan dibeli).

**Yang kejadian di belakang layar** (RPC `create_pos_sale`, `security definer` — satu-satunya jalur tulis role `cashier`, lihat `memory/architecture/data/pos-schema.md`): 2 jurnal otomatis tercatat,
```
Debit Kas Toko (1100)                     100.000
  Kredit Pendapatan Penjualan Toko (4100)         100.000

Debit Harga Pokok Penjualan (5100)      <avg_cost>
  Kredit Persediaan Barang Jadi (1420)            <avg_cost>
```
`Pendapatan Penjualan Toko` sengaja beda akun dari `Pendapatan Penjualan Grosir` yang dipakai AR Invoice ke 3 pelanggan grosir — biar dua channel jualan kelihatan terpisah di laporan.

## 3. Checkout — Bayar QRIS (12 Agustus 2026)

Pembeli lain beli **1 Kursi Plastik Lipat** (Rp75.000), bayar QRIS — duitnya masuk rekening bank toko, bukan laci kas fisik.

**UI:**
1. Klik kartu **Kursi Plastik Lipat** sekali.
2. Di panel Metode Bayar, klik tombol **QRIS** (background gelap pindah ke situ, Tunai jadi gak aktif).
3. Total tetap Rp75.000, klik **Checkout**.

Jurnalnya beda cuma di akun debit: `Debit Kas di Bank (1200) 75.000 / Kredit Pendapatan Penjualan Toko 75.000`, plus baris HPP/Persediaan seperti biasa — akun bank kepilih otomatis dari `payment_method` yang kamu klik, bukan field terpisah yang perlu diisi manual.

## 4. Setup Dulu di `apps/erp`: Kategori Biaya Tambahan & PPN

Sebelum kasir bisa nambahin biaya packing atau kena PPN pas checkout, **Pak Herman (admin) wajib setup dulu** di `apps/erp` — kasir gak pernah pilih akun bebas, cuma milih dari katalog yang udah disiapkan.

**UI (`apps/erp` `/settings/charges`, grup sidebar "Settings"):**
1. Halaman **"Kategori & Pajak"** — 4 kartu berurutan: **Kategori Biaya Tambahan — POS**, **Kategori Pendapatan Tambahan — AR Invoice**, **Kategori Beban/Persediaan Tambahan — AP Bill**, **Pengaturan Pajak (PPN)**.
2. Di kartu **"Kategori Biaya Tambahan — POS"**: isi field **Nama Kategori** dengan `Biaya Packing`, pilih **Akun** dari dropdown (misal akun pendapatan jasa yang udah ada di COA, atau akun baru kalau Pak Herman udah nambahin lewat `/accounts`). Klik **+ Tambah**.
3. Baris baru muncul di tabel di atasnya: Nama "Biaya Packing", Akun terpilih, Status **Aktif** (badge hijau). Ada tombol **Nonaktifkan** di ujung kanan tiap baris kalau suatu saat kategori ini mau dipensiunkan (bukan dihapus — `archived_at` di-set, bukan delete row).
4. Scroll ke kartu **"Pengaturan Pajak (PPN)"**. Centang checkbox **"Kios ini wajib pungut PPN (PKP)"**.
5. Isi **Tarif PPN (%)** — default `11`, biarin apa adanya (tarif PPN Indonesia).
6. Pilih **Akun PPN Keluaran (AR/POS)** dari dropdown (akun liability, misal "PPN Keluaran" kalau sudah ada di COA).
7. Klik **Simpan Pengaturan Pajak**. Muncul teks kecil hijau "Tersimpan." di bawah tombol.

Cuma role **admin** yang bisa isi form-form ini — kalau login sebagai `accountant`/role lain, field-nya kebaca tapi disabled dan gak ada tombol Simpan/Tambah (teks di atas halaman kasih tau: "Cuma role admin yang bisa ubah — kamu cuma bisa lihat").

## 5. Checkout — Biaya Packing + PPN dalam 1 Transaksi (13 Agustus 2026)

Toko Serba Ada Barokah (salah satu pelanggan grosir) kirim orang buat beli langsung di kios — borongan **10 Ember Plastik 10L** (Rp35.000/pcs) buat dibawa pulang saat itu juga, bukan lewat invoice grosir. Minta dibungkus rapi (kena Biaya Packing), dan diasumsikan kios ini sudah PKP jadi kena PPN 11% (mengikuti setup bagian 4 di atas).

**UI (`apps/pos`):**
1. Klik kartu **Ember Plastik 10L** sampai qty di keranjang jadi **10** (klik 10× atau klik lalu edit qty pakai tombol **+**).
2. Subtotal Barang di ringkasan: `10 × 35.000 = 350.000`.
3. Di section **"Biaya Tambahan (opsional)"**, klik **+ Tambah kategori** — muncul 1 baris baru: dropdown kategori + input nominal.
4. Pilih **"Biaya Packing"** dari dropdown, isi nominal `10000` di kotak angka sebelahnya.
5. Karena PPN sudah diaktifkan Pak Herman (bagian 4), muncul checkbox **"Kena PPN (11%)"** — centang.
6. Ringkasan otomatis update:
   ```
   Subtotal Barang       350.000
   Biaya Tambahan          10.000
   PPN                     39.600   (11% × (350.000+10.000))
   Total                   399.600
   ```
7. Pilih metode bayar **Tunai**, opsional pilih pelanggan **Toko Serba Ada Barokah** dari dropdown "Pelanggan" (murni buat riwayat/traceability — transaksi ini TETAP POS Sale tunai, bukan jadi piutang AR).
8. Klik **Checkout** → sukses, total Rp399.600.

Jurnal yang kebentuk otomatis (1 kredit basket item + 1 kredit packing + 1 kredit PPN, tetap 1 jurnal Kas yang sama — bukan 3 jurnal terpisah):
```
Debit Kas Toko                           399.600
  Kredit Pendapatan Penjualan Toko               350.000
  Kredit Biaya Packing (akun dari katalog)        10.000
  Kredit PPN Keluaran                             39.600

Debit Harga Pokok Penjualan            <total avg_cost 10 Ember>
  Kredit Persediaan Barang Jadi                  <sama>
```
PPN dihitung sistem, bukan diketik kasir — kasir cuma centang checkbox.

## 6. Checkout — Ditolak Karena Stok Gak Cukup

Ada pembeli mau borong **50 Rak Plastik Serbaguna** sekaligus, padahal stok yang keliatan di kartu katalog cuma tinggal **12**.

**UI:**
1. Klik kartu Rak Plastik Serbaguna — tombol **+** di panel keranjang otomatis disabled begitu qty nyentuh 12 (dicek client-side dari `qtyOnHand`), jadi secara UI kamu gak bisa naikin lebih dari stok yang keliatan.
2. Kalaupun devicenya sempat kerja dari data stok basi (jarang, tapi ini kenapa checkout WAJIB online) dan qty ilegal sempat ke-submit, `create_pos_sale` tetap ngecek ulang `inventory_balances` real-time di server SEBELUM bikin jurnal apa pun — kalau qty > stok beneran, RPC `raise exception`, checkout gagal total (no partial write), pesan error merah muncul di panel keranjang, keranjang gak ke-clear.

## 7. Pak Herman Lihat Riwayat Transaksi Kios

Sore hari, Pak Herman mau ngecek transaksi kios hari ini.

**UI (`apps/erp` `/pos-sales`):**
1. Halaman **"POS Sales — Toko Plastik Makmur Jaya"** — tabel list, kolom: Tanggal, Source Ref, Pelanggan, Metode Bayar, Total, Status.
2. Transaksi bagian 2 (Ember+Piring tunai) muncul: Pelanggan **"Walk-in"**, Metode Bayar **"Kas Toko"**, Total **100.000**, Status badge hijau **"Normal"**.
3. Transaksi bagian 5 (borongan + packing + PPN) muncul dengan Pelanggan **"Toko Serba Ada Barokah"**, Total **399.600**.
4. Klik tombol **Refresh** di toolbar kalau mau re-fetch data terbaru tanpa reload halaman.
5. **Klik salah satu baris** (misal transaksi Kursi Plastik Lipat QRIS bagian 3) — navigasi ke halaman detail `/pos-sales/[id]`.

## 8. Detail Transaksi + Pembatalan (Void)

Ternyata transaksi Kursi Plastik Lipat di bagian 3 salah — Mbak Rina kepencet QRIS padahal pembeli sebenarnya bayar tunai.

**UI (`apps/erp` `/pos-sales/[id]`):**
1. Header halaman: nama pelanggan/"Walk-in" + Source Ref, badge status ("Normal"), tanggal + "Bayar via Kas di Bank", dan di kanan atas **Total Rp75.000** + tombol **Batalkan** (cuma muncul kalau kamu login sebagai `admin`/`accountant` DAN transaksi belum pernah dibatalkan).
2. Kartu info: Pelanggan, Akun Pendapatan, Total HPP.
3. Tabel **"Barang Terjual"**: baris per item — Kursi Plastik Lipat, qty, harga satuan, total, HPP.
4. Tabel **"Jurnal Terkait"**: 2 baris entry (jurnal Kas/Pendapatan dan jurnal HPP/Persediaan), tiap baris nunjukin semua `journal_lines`-nya (kode+nama akun, D/K nominal).
5. Klik tombol **Batalkan**. Muncul `window.prompt` — isi rujukan dokumen buat entry pembalik, misal `Pembatalan salah metode bayar`. Klik OK.
6. Setelah berhasil: badge status berubah jadi merah **"Dibatalkan"**, tombol Batalkan hilang (gak bisa dibatalkan dua kali), tabel Jurnal Terkait sekarang menampilkan 4 entry (2 asli + 2 pembalik).
7. Mbak Rina input ulang transaksi yang benar (1 Kursi Plastik Lipat, Tunai) lewat `apps/pos` seperti bagian 2 — POS Sale baru, bukan edit yang lama (row asli TETAP ada di histori, gak pernah di-`UPDATE`/`DELETE`, konsisten pola immutability seluruh sistem).

**Yang kejadian di balik layar** (`void_pos_sale`, `security invoker` — beda dari `create_pos_sale`, cuma admin/accountant yang manggil dan mereka udah lolos RLS biasa): kedua jurnal asli dibalik via `reverse_journal_entry`, DAN `inventory_balances` di-update manual buat balikin `qty_on_hand` Kursi Plastik Lipat (`avg_cost` gak disentuh) — beda dari sisi jurnal doang, karena reversing entry gak otomatis mulihin stok.

## Ringkasan Alur

```
Mbak Rina (apps/pos)                    Pak Herman (apps/erp)
─────────────────────                   ─────────────────────
Login kasir
Klik item → keranjang
Pilih metode bayar
(opsional) Biaya tambahan + PPN   <──── /settings/charges: siapkan
(opsional) Pilih pelanggan               katalog kategori + Pengaturan Pajak
Checkout → create_pos_sale
                                          /pos-sales: lihat riwayat
                                          /pos-sales/[id]: detail + Batalkan
                                          → void_pos_sale kalau salah input
```

## Lanjutan Story

Kebijakan retur kios masih belum diputuskan (`memory/special-case/pos-retur-policy.md`) — begitu diputuskan, submodule baru bakal ditambahkan di sini.
