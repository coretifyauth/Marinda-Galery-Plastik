# Story — General Ledger & Journal Entry: CV Roti Barokah

Fase 2. Konteks bisnis: `docs/story/company-profile.md`. Konsep: `docs/domain/human/general-ledger.md`. Schema: `docs/architecture/data/journal-entry-schema.md`. Akun yang dipakai: `docs/story/chart-of-accounts.md`.

## Transaksi Juli 2026 (seed data nyata)

Dijalankan lewat `supabase/migrations/0005_seed_demo_journal_entries.sql`, manggil RPC `create_journal_entry` (bukan insert langsung) — jadi beneran lewat validasi leaf-only & balance-check yang sama kayak yang dipakai app.

| Tanggal | Kejadian | Debit | Kredit |
|---|---|---|---|
| 1 Jul | Setoran modal awal Rp10.000.000 | Kas di Bank 10.000.000 | Modal Pemilik 10.000.000 |
| 5 Jul | Jual roti tunai di kios Rp500.000 | Kas Toko 500.000 | Pendapatan Penjualan Toko 500.000 |
| 7 Jul | Kirim roti ke Warung Pak Budi, termin, Rp1.200.000 | Piutang Usaha 1.200.000 | Pendapatan Penjualan Grosir 1.200.000 |
| 10 Jul | Beli tepung & gula, belum bayar, Rp800.000 | Persediaan Bahan Baku 800.000 | Utang Usaha 800.000 |
| 15 Jul | Bayar gaji karyawan Rp2.000.000 | Beban Gaji Karyawan 2.000.000 | Kas di Bank 2.000.000 |
| 20 Jul | Bayar cicilan KUR: pokok 1jt + bunga 150rb | Utang Bank 1.000.000 + Beban Bunga Bank 150.000 | Kas di Bank 1.150.000 |

Entry terakhir sengaja 3 baris (compound entry) — persis contoh di domain doc, sekarang beneran ada datanya di database.

## Efek ke saldo (General Ledger `Kas di Bank`)

Kalau buka General Ledger buat akun `1200 Kas di Bank`, urutannya:

| Tanggal | Deskripsi | Debit | Kredit | Saldo Berjalan |
|---|---|---|---|---|
| 1 Jul | Setoran modal awal | 10.000.000 | | 10.000.000 |
| 15 Jul | Bayar gaji karyawan Juli minggu 2 | | 2.000.000 | 8.000.000 |
| 20 Jul | Bayar cicilan KUR: pokok + bunga | | 1.150.000 | 6.850.000 |

Saldo akhir `Kas di Bank` per 20 Juli 2026: **Rp6.850.000**.

## Simulasi Interface

Web app sekarang punya halaman `/journal-entries` (list + form tambah entry, dengan baris debit/kredit dinamis + validasi balance real-time sebelum submit) dan `/general-ledger` (pilih akun, lihat histori + saldo berjalan). Coba:

1. Buka `/general-ledger`, pilih `Kas di Bank` — bandingkan sama tabel di atas, saldo berjalan harus persis sama.
2. Buka `/journal-entries`, coba bikin entry baru yang **sengaja gak balance** (misal debit 100rb, kredit 50rb) — submit harus ketolak (RPC `create_journal_entry` bakal manggil trigger `journal_lines_balance_check`), sebelum sempat submit form-nya sendiri udah kasih tau lewat validasi client-side.
3. Coba posting ke akun header (misal `1000 Kas` atau `1600 Aset Tetap`) — dropdown akun di form udah difilter cuma nampilin leaf account, tapi kalau dites lewat RPC langsung (curl/SQL Editor), trigger `journal_lines_leaf_only` yang nolak.

## Lanjutan Story

Fase berikutnya (Accounts Receivable) bakal nagih Piutang Usaha dari Warung Pak Budi (entry 7 Juli di atas) — pelunasannya jadi contoh transaksi pertama modul AR.
