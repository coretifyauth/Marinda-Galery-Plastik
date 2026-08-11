# Story — Fixed Assets: Toko Plastik Makmur Jaya

Konteks bisnis: `docs/story/company-profile.md`. Konsep: `docs/domain/fixed-assets.md`. ERD & DDL: `memory/architecture/data/fixed-assets-schema.md`. Lanjutan dari `docs/story/inventory.md` — 2 aset di sini (Mobil Pickup Antar Barang, Rak Display Toko) udah disebut sejak `company-profile.md`, baru sekarang penyusutannya beneran dicatat.

Ditulis sebagai tutorial klik-per-klik: sebut menu sidebar, URL, field, tombol, dan hasil yang harus muncul. Login sebagai Pak Herman (`admin`).

Timeline: **akuisisi 2023–2024** (sesuai `company-profile.md`), penyusutan diposting sampai **2025** (posisi lengkap sebelum "hari ini", Agustus 2026).

**Peta menu.** Sidebar kiri, grup sendiri **Fixed Assets** (ikon `Building2`, terpisah dari grup Inventory) → 1 item menu: **Fixed Assets** (`/fixed-assets`). List-nya klik-baris-ke-detail; satu-satunya aksi transaksional ("Posting Penyusutan") hidup di halaman detail `/fixed-assets/[id]`, bukan di row list (`memory/preferences/ui/admin-shell-design.md`).

**Catatan akun (baca sebelum mulai):** RPC `create_fixed_asset` butuh 3 akun — aset (kategori `asset`, non-kontra), akumulasi penyusutan (kategori `asset`, **wajib `is_contra=true`**), beban penyusutan (kategori `expense`). Form `/accounts` (Chart of Accounts) buat bikin akun baru **gak punya toggle `is_contra`** — akun baru dari situ selalu `is_contra=false`. Artinya akun kontra-aset baru cuma bisa dibuat lewat migration SQL, gak ada jalur UI. Seed awal cuma nyediain 2 pasang akun kontra siap pakai: `1610/1630/5600` dan `1620/1640/5610` (nama akunnya warisan skenario lama — "Oven"/"Motor" — tapi struktur perannya pas: aset non-kontra / akumulasi kontra / beban). Walkthrough ini pakai ulang dua pasang itu apa adanya buat Mobil Pickup & Rak Display Toko — bukan salah ketik, ini keterbatasan UI nyata yang sengaja didemoin di sini, bukan didiemin.

## Master Data Aset

| Aset | Nilai Perolehan | Nilai Residu | Umur Manfaat | Metode | Akun Aset | Akun Kontra | Akun Beban | Dibiayai |
|---|---|---|---|---|---|---|---|---|
| Mobil Pickup Antar Barang | Rp180.000.000 | Rp30.000.000 | 5 tahun (60 bulan) | **Declining Balance** (35%/tahun) | `1620 Kendaraan Motor` | `1640 Akumulasi Penyusutan Motor` | `5610 Beban Penyusutan Motor` | Pinjaman Bank (`2200 Utang Bank`) |
| Rak Display Toko | Rp15.000.000 | Rp0 | 5 tahun (60 bulan) | **Straight-Line** | `1610 Peralatan Oven` | `1630 Akumulasi Penyusutan Oven` | `5600 Beban Penyusutan Oven` | Kas (`1200 Kas di Bank`) |

Dua metode beda sengaja dipilih: kendaraan cepat kehilangan nilai di tahun-tahun awal (declining balance cocok), rak display manfaatnya rata tiap tahun (straight-line cocok) — sama alasan yang dipakai `docs/domain/fixed-assets.md` bagian "Metode Penyusutan".

## Tahap 1 — Daftarkan Mobil Pickup Antar Barang (15 Januari 2024)

Beli mobil pickup buat antar barang ke 3 pelanggan grosir, dibayar pakai pinjaman bank.

**Menu:** Fixed Assets → **Fixed Assets** (`/fixed-assets`). Klik **+ New**.

- **Nama Aset**: `Mobil Pickup Antar Barang`
- **Akun Aset Tetap**: `1620 — Kendaraan Motor`
- **Akun Akumulasi Penyusutan**: `1640 — Akumulasi Penyusutan Motor`
- **Akun Beban Penyusutan**: `5610 — Beban Penyusutan Motor`
- **Nilai Perolehan**: `180000000`
- **Nilai Residu**: `30000000`
- **Umur Manfaat (bulan)**: `60`
- **Tanggal Akuisisi**: `2024-01-15`
- **Metode Penyusutan**: `Declining Balance`
- **Tarif per Periode Posting (0-1)**: `0.35` (35% — field ini cuma muncul kalau metode `Declining Balance` dipilih)

Klik **Simpan Aset**. Baris baru muncul di list Fixed Assets: Nama, badge Metode (`Declining Balance (35%)`), Nilai Perolehan `180.000.000`, Akumulasi Penyusutan `0`, Nilai Buku `180.000.000`.

**Jurnal akuisisi dicatat terpisah, bukan lewat RPC ini** (form eksplisit bilang ini di atas): buka menu Accounting → Journal Entries, bikin jurnal umum manual:
```
Debit  1620 Kendaraan Motor    180.000.000
Kredit 2200 Utang Bank                       180.000.000
```
(`create_fixed_asset` cuma nyimpen master data — dasar penyusutan berikutnya, gak nyentuh Journal Entries sama sekali.)

## Tahap 2 — Daftarkan Rak Display Toko (10 Januari 2024)

Beli rak-rak display buat toko fisik, dibayar cash dari kas bank.

Di `/fixed-assets`, klik **+ New** lagi:

- **Nama Aset**: `Rak Display Toko`
- **Akun Aset Tetap**: `1610 — Peralatan Oven`
- **Akun Akumulasi Penyusutan**: `1630 — Akumulasi Penyusutan Oven`
- **Akun Beban Penyusutan**: `5600 — Beban Penyusutan Oven`
- **Nilai Perolehan**: `15000000`
- **Nilai Residu**: `0`
- **Umur Manfaat (bulan)**: `60`
- **Tanggal Akuisisi**: `2024-01-10`
- **Metode Penyusutan**: `Straight-Line` (default — field "Tarif" gak muncul buat metode ini)

Klik **Simpan Aset**. List Fixed Assets sekarang 2 baris.

Jurnal akuisisi (Journal Entries, manual):
```
Debit  1610 Peralatan Oven      15.000.000
Kredit 1200 Kas di Bank                      15.000.000
```

## Tahap 3 — Posting Penyusutan Rak Display Toko (Straight-Line, 12x Bulanan Sepanjang 2024)

Formula: `(15.000.000 − 0) ÷ 60 bulan = Rp250.000/bulan`, sama tiap bulan.

Klik baris **Rak Display Toko** di list → `/fixed-assets/[id]`. Di pojok kanan atas ada tombol **Posting Penyusutan** — **ini satu-satunya aksi transaksional modul ini, dan hidup di halaman detail, bukan di row list**. Klik tombol itu → form muncul di atas section detail:

- **Periode**: `2024-01-31`
- **Rujukan dokumen**: `PENYST-RAK-2024-01`
- **Jumlah Manual (jarang dipakai)**: kosongkan — dibiarkan dihitung otomatis dari formula straight-line

Klik **Post**. Section "Histori Penyusutan" di bawah nambah 1 baris: Periode `2024-01-31`, Jumlah `250.000`, Akumulasi `250.000`, Nilai Buku `14.750.000`. Header kanan atas (Nilai Buku + Akumulasi/cap) ikut ter-update live.

Ulangi klik **Posting Penyusutan** → isi Periode berturut-turut `2024-02-29`, `2024-03-31`, ..., `2024-12-31` (rujukan disesuaikan tiap bulan, mis. `PENYST-RAK-2024-02` dst), Jumlah Manual selalu dikosongkan — 12 kali total. Tiap posting nambah baris baru di "Histori Penyusutan", gak pernah nimpa yang lama (immutable, `block_edit_delete`).

Setelah 12x posting: **Akumulasi Penyusutan = Rp3.000.000**, **Nilai Buku = Rp12.000.000** — keliatan langsung di header halaman detail (`Akumulasi 3.000.000 / cap 15.000.000`).

Coba klik **Posting Penyusutan** sekali lagi lalu buka tab "Konsep Inti" di kepala halaman: begitu ada minimal 1 baris penyusutan, badge kuning muncul — *"🔒 Aset ini udah punya penyusutan — nilai perolehan/residu/umur manfaat/metode/akun terkunci"*. Field-field itu jadi read-only kalau dicoba diedit (published-lock, `fixed_assets_published_lock`); cuma nama & status arsip yang masih bebas diubah.

## Tahap 4 — Posting Penyusutan Mobil Pickup (Declining Balance, 2x Tahunan)

Beda cadence dari rak display — mobil pickup diposting **tahunan** (bukan bulanan), buat nunjukin `period` fleksibel selama `depreciation_rate` (35%) konsisten sama periode postingnya (tarif per periode posting, bukan otomatis per-tahun — kalau posting bulanan, tarif yang diisi ya tarif bulanan; di sini tahunan, jadi 35% memang tarif tahunan).

Buka `/fixed-assets/[id]` punya **Mobil Pickup Antar Barang**. Klik **Posting Penyusutan**:

**Tahun 1 (2024):** **Periode** `2024-12-31`, **Rujukan** `PENYST-PICKUP-2024`, **Jumlah Manual** kosong. Klik **Post**. Formula declining balance: `Nilai Buku Awal (180.000.000) × 35% = Rp63.000.000`. Histori nambah 1 baris: Jumlah `63.000.000`, Akumulasi `63.000.000`, Nilai Buku `117.000.000`.

**Tahun 2 (2025):** klik **Posting Penyusutan** lagi. **Periode** `2025-12-31`, **Rujukan** `PENYST-PICKUP-2025`, **Jumlah Manual** kosong. Klik **Post**. Formula dihitung ulang dari nilai buku SISA (bukan nilai perolehan awal): `117.000.000 × 35% = Rp40.950.000`. Histori nambah baris kedua: Jumlah `40.950.000`, Akumulasi `103.950.000`, Nilai Buku `76.050.000` — makin kecil tiap tahun (ciri khas declining balance, beda dari straight-line yang rata).

## Tahap 5 — Coba Lewat Batas Cap (Uji Coba Trigger Proteksi)

Fitur "Jumlah Manual" di form Posting Penyusutan biasanya dikosongkan — dipakai cuma buat penyesuaian periode TERAKHIR declining balance biar nilai buku pas berhenti di nilai residu (`FormHint` di form itu bilang ini eksplisit). Buat lihat jaring pengamannya jalan, coba ini di halaman detail Mobil Pickup:

Klik **Posting Penyusutan**. **Periode** `2026-12-31`, **Rujukan** `TEST-CAP`, **Jumlah Manual** diisi sengaja kelewat besar: `999999999`. Klik **Post**.

**Hasil yang harus muncul: error, bukan sukses.** Cap = nilai perolehan − residu = `180.000.000 − 30.000.000 = 150.000.000`; akumulasi berjalan `103.950.000` + amount override `999.999.999` jauh ngelewatin sisa yang boleh (`46.050.000`). Trigger `depreciation_entries_cap_check` di database nolak insert-nya dengan pesan mirip *"Penyusutan aset ... melebihi batas (sisa 46.050.000, coba 999.999.999)"* — muncul sebagai `FormError` merah di bawah form, histori penyusutan TIDAK nambah baris baru. Ini jaring kedua yang tetap jalan di level database, bukan cuma validasi di RPC/UI (kalau ada jalur insert lain yang bypass RPC, cap tetap ketutup).

Setelah tahu triggernya jalan, klik **Batal** buat nutup form tanpa nyoba lagi.

## Posisi Akhir per 31 Desember 2025

| Aset | Nilai Perolehan | Akumulasi Penyusutan | Nilai Buku |
|---|---|---|---|
| Rak Display Toko | 15.000.000 | 3.000.000 | **12.000.000** |
| Mobil Pickup Antar Barang | 180.000.000 | 103.950.000 | **76.050.000** |

Cek angka ini langsung di list `/fixed-assets` (kolom Nilai Perolehan/Akumulasi Penyusutan/Nilai Buku, tanpa perlu buka detail satu-satu). Ini yang muncul di Neraca: `Aset Tetap` (gross, 2 baris) dikurangi `Akumulasi Penyusutan` (2 baris kontra), Nilai Buku total = Rp88.050.000. `Beban Penyusutan Motor` (Rp103.950.000 kumulatif) + `Beban Penyusutan Oven` (Rp3.000.000 kumulatif) muncul di Laporan Laba Rugi sebagai biaya operasional — komponen biaya di luar HPP yang sudah dihitung di `docs/story/inventory.md`.

**Belum ada mekanisme pelepasan aset** (disposal) — kalau suatu saat Mobil Pickup dijual/rusak total, sistem belum punya RPC/tabel buat mencatat pelepasan & laba-rugi dari situ (`memory/domain/fixed-assets.md`, belum ada scope-debt file buat ini). Di luar cakupan walkthrough ini.

## Lanjutan Story

Fase berikutnya (Financial Reports) narik semua saldo — termasuk Nilai Buku Aset Tetap & Beban Penyusutan dari sini plus Persediaan & HPP dari `docs/story/inventory.md` — jadi Neraca dan Laporan Laba Rugi Toko Plastik Makmur Jaya yang utuh, tujuan akhir motivasi bisnis di `company-profile.md` (bisa dipakai ajukan pinjaman modal tambahan ke bank).
