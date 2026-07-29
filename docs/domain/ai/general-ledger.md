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

## Period closing — konsep, belum termasuk scope implementasi awal

Tutup periode (biasanya bulanan): akun Revenue/Expense di-nol-kan via closing entry (selisih laba/rugi dipindah ke `Laba Ditahan`), lalu periode dikunci — gak ada entry baru boleh bertanggal masuk ke situ. **Berbeda level dari constraint immutability di atas**: immutability berlaku per-entry sejak entry pertama; period closing berlaku per-rentang-waktu, baru relevan begitu ada proses tutup buku formal (butuh laporan keuangan/Income Statement jalan dulu buat tau total definitif per akun yang mau ditutup). Keduanya independen — sebuah entry immutable di periode yang masih terbuka.

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
- **Period closing**: proses nutup periode — nol-in Revenue/Expense ke Laba Ditahan, kunci periode dari entry baru.

Naratif lengkap + reasoning penuh: `docs/domain/human/general-ledger.md`.
