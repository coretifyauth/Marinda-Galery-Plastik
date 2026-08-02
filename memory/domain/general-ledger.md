# General Ledger & Journal Entry — AI Context

Journal Entry = unit pencatatan 1 kejadian bisnis, ≥2 baris debit/kredit. General Ledger = agregat semua journal entry yang udah diposting, dikelompokkan per akun — sumber saldo tiap akun di COA (termasuk rollup header/leaf).

## Constraints (wajib ditegakkan di implementasi, bukan sekadar UI validation)

- **Balance**: `SUM(debit) = SUM(credit)` per journal entry. Konsekuensi langsung persamaan akuntansi.
- **Min 2 lines / ≥2 akun berbeda** per entry (double-entry). Bisa >2 (compound entry).
- **Leaf-only posting**: `account_id` di tiap line wajib leaf (gak punya child) — ref `chart-of-accounts.md`.
- **Immutability**: `journal_entries`/`journal_lines` gak pernah di-UPDATE/DELETE setelah dibuat. Koreksi = entry baru yang membalik (debit↔kredit ditukar), rujuk entry asli via `reverses_entry_id`.
- **Traceability**: `source_ref` wajib diisi tiap entry (nomor nota/kuitansi/kontrak).
- **Atomicity**: header + semua lines dibuat dalam 1 transaksi/RPC — gagal sebagian = batal semua, gak boleh nyisa entry setengah jadi.

## Accrual basis (bukan cash basis)

Revenue diakui pas earned (barang/jasa berpindah), Expense diakui pas incurred — bukan pas kas beneran pindah (matching principle). Ini alasan `Piutang Usaha`/`Utang Usaha` ada di COA: nampung jeda waktu antara kejadian dan kas.

## Contoh transaksi generik (dipakai buat referensi test/validasi logic, bukan seed data — seed data spesifik ada di `docs/story/`)

| # | Kejadian | Debit | Kredit |
|---|---|---|---|
| 1 | Jual jasa/barang tunai Rp500.000 | Kas 500.000 | Pendapatan 500.000 |
| 2 | Jual jasa/barang Rp1.200.000, belum dibayar (termin) | Piutang Usaha 1.200.000 | Pendapatan 1.200.000 |
| 3 | Beli persediaan/bahan baku Rp800.000, belum dibayar | Persediaan 800.000 | Utang Usaha 800.000 |
| 4 | Bayar gaji karyawan tunai Rp2.000.000 | Beban Gaji 2.000.000 | Kas 2.000.000 |
| 5 | Bayar cicilan pinjaman: pokok 1.000.000 + bunga 150.000 | Utang Bank 1.000.000 + Beban Bunga 150.000 | Kas 1.150.000 |

Transaksi #3: beli persediaan nambah asset, BUKAN langsung expense — HPP baru diakui pas terjual (Inventory, fase terpisah). Journal Entry module tetap generik, gak perlu tau logic inventory.

## Period closing — dibangun di Fase 7 (`0016_period_closing.sql`)

Tutup periode (rentang tanggal bebas, gak hardcode bulanan): akun Revenue/Expense di-nol-kan via closing entry (selisih laba/rugi dipindah ke `Laba Ditahan`), lalu periode dikunci — gak ada entry baru boleh bertanggal masuk ke situ (trigger `journal_entries_block_retroactive_into_closed_period`). **Berbeda level dari constraint immutability di atas**: immutability berlaku per-entry sejak entry pertama; period closing berlaku per-rentang-waktu. Keduanya independen — sebuah entry immutable di periode yang masih terbuka.

Ditunda dari Fase 2 ke Fase 7 karena butuh laporan keuangan/Income Statement jalan dulu buat tau total definitif per akun yang mau ditutup. RPC `close_period` hitung ulang saldo langsung dari `journal_lines` (gak percaya angka dari client). Periode harus ditutup berurutan-bersambung, gak ada jalur reopen. Detail teknis penuh: `memory/architecture/data/financial-reports-schema.md` bagian "Period Closing".

**Cara kerja langkah demi langkah** (detail non-teknis: `docs/domain/general-ledger.md` bagian "Cara Kerja Sistem"):
1. User kasih rentang tanggal + akun equity tujuan (`Laba Ditahan`).
2. Server hitung ULANG saldo Revenue/Expense rentang itu dari `journal_lines` — bukan pakai angka laporan yang mungkin udah dilihat user sebelumnya (bisa basi kalau ada entry baru masuk di antaranya).
3. Susun 1 closing entry: debit tiap akun Revenue sejumlah saldonya, kredit tiap akun Expense sejumlah saldonya, selisihnya (laba/rugi) ke akun equity tujuan (kredit=laba, debit=rugi).
4. Closing entry itu di-`create_journal_entry` DULU, baris `period_closings` (yang jadi kuncian) ditambah BELAKANGAN — urutan sengaja, biar closing entry sendiri (bertanggal `end_date`) gak ketolak trigger kuncian yang baru aja dia bikin sendiri.
5. Rentang tanpa aktivitas Revenue/Expense sama sekali tetap dicatat tertutup, tanpa closing entry (`journal_entry_id` nullable).
6. Sejak `period_closings` row itu ada, trigger nolak SEMUA `journal_entries` baru (lintas modul — lihat "Cakupan kuncian" di bawah) yang `entry_date`-nya masuk rentang itu.
7. Divalidasi duluan sebelum semua ini jalan: kontiguitas (`start_date` = `end_date` closing terakhir + 1 hari) dan gak overlap (dijaga plpgsql check + advisory lock + exclusion constraint GiST, `financial-reports-schema.md`).

**Soft close vs hard close**: cuma 1 mekanisme di sistem ini (hard — closing entry + lock). "Soft close" bukan mekanisme terpisah, itu istilah buat "sekadar jalanin `getIncomeStatement` buat suatu rentang tanpa posting/lock apa pun" — udah otomatis bisa dilakuin tanpa kode tambahan.

**Cadence bebas**: `close_period` terima rentang tanggal APA PUN (gak ada kolom `period_type`) — bulanan/kuartalan/tahunan/campur, terserah caller, asal berurutan-bersambung (gak boleh ada gap/lompatan). Best practice buat skala UMKM: hard close cukup tahunan (selaras SPT Tahunan pajak + momen lapor ke bank), jangan kesering (makin sering ditutup makin tinggi risiko transaksi telat kejebak) — review internal bulanan cukup pakai laporan Income Statement biasa (soft, gak dikunci).

**Cakupan kuncian lintas modul**: semua RPC financial write (AR/AP/Inventory/Fixed Assets) manggil `create_journal_entry` di baliknya — begitu 1 rentang di-hard-close, invoice/bill/depresiasi/goods issue/reversing entry apa pun yang bertanggal masuk rentang itu ikut ditolak, bukan cuma entry manual.

## Common mistakes to guard against

- Posting cuma 1 baris (lupa sisi lawan) — harus gagal validasi, bukan lolos.
- Edit journal entry yang salah langsung, bukan reversing entry — ngerusak audit trail.
- Posting ke header account (harusnya leaf paling detail).
- Cash-basis padahal transaksinya termin (accrual) — Piutang/Utang gak kebentuk, laporan gak nyerminin posisi riil.
- `source_ref` kosong — entry gak bisa ditelusuri ke bukti fisik.

## Glossary

- **Journal Entry**: catatan 1 transaksi, terdiri dari header + ≥2 baris debit/kredit yang balance.
- **General Ledger**: kumpulan semua journal entry per akun — sumber saldo.
- **Accrual basis**: pencatatan berdasar kejadian, bukan aliran kas.
- **Matching principle**: pendapatan/beban dicocokkan ke periode kejadian sebenarnya.
- **Compound entry**: journal entry dengan >2 baris.
- **Reversing entry**: entry baru yang membalik entry lain buat koreksi, tanpa edit yang lama.
- **Period closing / hard close**: proses nutup periode — nol-in Revenue/Expense ke Laba Ditahan, kunci periode dari entry baru. Satu-satunya mekanisme closing yang ada di sistem ini.
- **Soft close**: bukan mekanisme terpisah — istilah buat "liat laporan Income Statement suatu rentang tanpa posting/kunci apa pun", tetap bisa berubah kalau ada entry baru masuk rentang itu.

Naratif lengkap + reasoning penuh: `docs/domain/general-ledger.md`.
