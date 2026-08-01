# Fixed Assets — AI Context

Fixed Assets menyebar biaya perolehan aset yang dipakai berulang bertahun-tahun (oven, motor — beda dari bahan baku Inventory yang habis sekali pakai) ke sepanjang masa manfaatnya, lewat penyusutan periodik. **Prinsip inti: matching by time** — beda dari Inventory yang matching-nya dipicu kejadian (barang terjual), Fixed Assets matching-nya berjalan tiap periode waktu (tiap bulan) tanpa perlu kejadian pemicu.

## Alur Akuntansi

**Akuisisi** (tukar aset ke aset, sama pola Inventory):
```
Debit Aset Tetap [nilai perolehan] | Kredit Kas/Utang [nilai perolehan]
```

**Penyusutan** (tiap bulan, biaya diakui di sini):
```
Debit Beban Penyusutan [nilai bulanan] | Kredit Akumulasi Penyusutan [nilai bulanan]
```

**Kesalahan paling umum**: kredit langsung ke akun Aset Tetap saat penyusutan. Harusnya kredit ke akun **terpisah** — Akumulasi Penyusutan — supaya nilai perolehan asli tetap utuh (auditability) dan Neraca menampilkan Aset Tetap + Akumulasi Penyusutan (kontra) berdampingan, bukan 1 angka yang mengecil.

## Akun Kontra-Asset

Akumulasi Penyusutan: `category = asset`, tapi `normal_balance = credit` (kebalikan asset biasa). General contra-account concept + cross-category examples: `docs/domain/ai/chart-of-accounts.md` "Contra Account" section. This is the first real usage in the project — no prior module (COA/GL/AR/AP/Inventory) has any contra account.

**Dampak schema**: `accounts.normal_balance` (`coa-schema.md`) generated column, `asset → debit` tanpa exception.

**Keputusan (Opsi A)**: add `accounts.is_contra boolean default false`, generated `normal_balance` formula branches on this flag. `is_contra` also added to `published` field-lock list (locked after account used in a transaction). Full rationale: `docs/scope-debt/fixed-assets-akun-kontra-asset.md`. Final DDL + migration: `docs/architecture/data/fixed-assets-schema.md` (`0014_fixed_assets_schema.sql`) — applied to a live Supabase instance, UI (`/fixed-assets`) built and tested.

## Metode Penyusutan (2 in-scope: Straight-Line + Declining Balance)

Per-asset (`fixed_assets.depreciation_method`), gak global. Common terms: **nilai perolehan** (harga beli + biaya siap pakai), **umur manfaat** (estimasi tahun/bulan pakai), **nilai residu** (estimasi nilai jual akhir, sering 0 untuk UMKM), **nilai buku** (`Nilai Perolehan - Akumulasi Penyusutan`, tampil di Neraca).

**Straight-Line**: `(Nilai Perolehan - Nilai Residu) / Umur Manfaat`, sama tiap periode. Contoh: Rp15.000.000/5 tahun/residu 0 → Rp3.000.000/tahun (Rp250.000/bulan).

**Declining Balance**: `Nilai Buku Awal Periode × Tarif%`, jadi ngecil tiap periode (nilai buku sisa makin kecil). Contoh: Rp24.000.000, residu Rp2.400.000, tarif 40%/tahun → tahun1: 24jt×40%=9,6jt, tahun2: 14,4jt×40%=5,76jt, tahun3: 8,64jt×40%=3,456jt, tahun4: dipotong ke 2,784jt biar pas residu. **Periode terakhir butuh potongan manual** ke sisa cap, jangan pakai rumus polos (bisa lewat residu).

Schema impact: `fixed_assets` += `depreciation_method enum('straight_line','declining_balance') default 'straight_line'` + `depreciation_rate numeric nullable` (wajib isi kalau declining_balance, harus null kalau straight_line). `depreciation_entries` **tidak berubah** — `amount` udah disimpan eksplisit per baris, otomatis nampung angka variabel declining balance tanpa struktur tambahan.

Unit Produksi (metode ke-3) di luar scope — butuh data pemakaian eksternal per periode (KM/batch), bukan cuma waktu berjalan. Lihat "Belum termasuk".

## Constraints (wajib ditegakkan di implementasi)

- Akumulasi Penyusutan gak boleh melebihi `(Nilai Perolehan - Nilai Residu)` — cap, cegah nilai buku negatif. Declining balance lebih rawan kena cap di periode akhir — wajib dicek tiap posting, bukan diasumsikan aman kayak straight-line.
- Akun Aset Tetap per unit aset konstan dari akuisisi sampai disposal — cuma Akumulasi Penyusutan yang bergerak.
- Tiap posting penyusutan tertelusur ke aset + periode spesifik (anti dobel-posting/kelewat), pola traceability sama modul lain.
- `depreciation_method` + `depreciation_rate` masuk field-lock setelah `published` — gak boleh ganti metode di tengah umur manfaat tanpa revaluasi formal (pola sama constraint costing method Inventory).

## Common mistakes to guard against

- Beban penuh di bulan beli (harusnya disebar via penyusutan).
- Kredit langsung ke akun Aset Tetap saat penyusutan (harusnya ke Akumulasi Penyusutan).
- Lupa nilai residu (bikin nilai buku bisa negatif).
- Penyusutan lewat batas nilai perolehan.

## Belum termasuk (di luar scope fase ini)

Detail: `docs/scope-debt/` — disposal aset, metode Unit Produksi (butuh data pemakaian eksternal, potensi coupling ke `production_orders`/Inventory), revaluasi aset, ganti metode di tengah umur manfaat aset.

## Glossary

- **Aset Tetap (Fixed Asset)**: barang dipakai berulang bertahun-tahun (bukan habis sekali pakai), disusutkan bertahap.
- **Penyusutan (Depreciation)**: proses menyebar nilai perolehan aset tetap jadi biaya sepanjang masa manfaatnya.
- **Akumulasi Penyusutan (Accumulated Depreciation)**: akun kontra-asset, saldo normal kredit, menampung total penyusutan yang sudah berjalan.
- **Nilai Buku (Net Book Value)**: Nilai Perolehan - Akumulasi Penyusutan, angka yang tampil di Neraca.
- **Nilai Residu (Salvage Value)**: estimasi nilai jual aset di akhir umur manfaat.
- **Garis Lurus (Straight-Line)**: metode penyusutan dengan nilai sama tiap periode.
- **Saldo Menurun (Declining Balance)**: metode penyusutan dengan tarif % dikali nilai buku sisa, nilainya ngecil tiap periode.

Naratif lengkap + reasoning penuh: `docs/domain/human/fixed-assets.md`.
