# Story — General Ledger & Journal Entry: Toko Plastik Makmur Jaya

Fase 2. Konteks bisnis: `docs/story/company-profile.md`. Konsep: `docs/domain/general-ledger.md`. Schema: `memory/architecture/data/journal-entry-schema.md`. Akun yang dipakai: `docs/story/chart-of-accounts.md`.

Sama kayak file COA — ini tutorial klik-per-klik di UI beneran, bukan cuma cerita. Login sebagai Pak Herman, ikutin langkah di bawah sambil beneran klik.

## Transaksi Agustus 2026 (contoh yang dipakai di seluruh langkah)

| Tanggal | Kejadian | Debit | Kredit |
|---|---|---|---|
| 1 Agu | Setoran modal awal Rp15.000.000 | Kas di Bank 15.000.000 | Modal Pemilik 15.000.000 |
| 5 Agu | Jual Ember Plastik 10L + Kursi Plastik Lipat tunai di toko Rp750.000 | Kas Toko 750.000 | Pendapatan Penjualan Toko 750.000 |
| 7 Agu | Kirim barang ke Toko Kelontong Sumber Rejeki, termin 30 hari, Rp3.500.000 | Piutang Usaha 3.500.000 | Pendapatan Penjualan Grosir 3.500.000 |
| 10 Agu | Beli stok ember & kursi dari PT Plastindo Jaya, belum bayar, Rp4.200.000 | Persediaan Barang Dagang 4.200.000 | Utang Usaha 4.200.000 |
| 15 Agu | Bayar gaji Mbak Rina Rp2.500.000 | Beban Gaji Karyawan 2.500.000 | Kas di Bank 2.500.000 |
| 20 Agu | Bayar cicilan mobil pickup: pokok 1.500.000 + bunga 200.000 | Utang Bank 1.500.000 + Beban Bunga Bank 200.000 | Kas di Bank 1.700.000 |

Entry 20 Agustus sengaja 3 baris (compound entry) — persis contoh compound di domain doc.

## Efek ke saldo (`1200 Kas di Bank`)

Kalau semua entry di atas udah kamu input (Langkah 2), urutan `Kas di Bank`:

| Tanggal | Deskripsi | Debit | Kredit | Saldo Berjalan |
|---|---|---|---|---|
| 1 Agu | Setoran modal awal | 15.000.000 | | 15.000.000 |
| 15 Agu | Bayar gaji Mbak Rina | | 2.500.000 | 12.500.000 |
| 20 Agu | Bayar cicilan mobil pickup | | 1.700.000 | 10.800.000 |

Saldo akhir `Kas di Bank` per 20 Agustus 2026: **Rp10.800.000**.

## Langkah 1 — Buka Journal Entries

Sidebar → grup **Accounting** → klik **Journal Entries**. URL: `/journal-entries`. Yang muncul: tabel list dengan kolom Tanggal, Deskripsi, Source Ref, Baris (ringkasan tiap baris debit/kredit-nya), Total. Toolbar di atas tabel cuma punya **Refresh** dan **+ New** (gak ada Filter di list ini, beda dari Chart of Accounts).

## Langkah 2 — Input entry manual (multi-baris, harus balance)

Klik **+ New** — form "Tambah Journal Entry" muncul di bawah tabel. Ambil baris **7 Agustus** dari tabel di atas sebagai contoh:

- **Tanggal**: `2026-08-07`
- **Deskripsi**: `Kirim barang ke Toko Kelontong Sumber Rejeki`
- **Rujukan dokumen (source_ref)**: `Nota #012`

Di bagian baris debit/kredit (2 baris minimum sudah tersedia):
- Baris 1 — dropdown **Akun**: pilih `1300 — Piutang Usaha`, kolom **Debit**: `3500000`, **Kredit**: kosongkan
- Baris 2 — dropdown **Akun**: pilih `4200 — Pendapatan Penjualan Grosir`, kolom **Kredit**: `3500000`, **Debit**: kosongkan

Perhatikan indikator di bawah baris-baris itu: "Total debit: 3.500.000 — Total kredit: 3.500.000" dengan label **Balance ✓** warna hijau. Tombol **Simpan Entry** baru aktif kalau status ini balance — coba isi salah satu angka beda dulu (misal kredit `3000000`) buat lihat labelnya jadi **Belum balance** warna merah dan tombol Simpan ke-disable duluan sebelum sempat submit.

Perbaiki lagi jadi balance, klik **Simpan Entry**. Entry baru muncul di paling atas list (list di-sort descending by tanggal).

Kalau mau nyoba compound entry (>2 baris), ulangi buat baris **20 Agustus**: klik **+ Tambah baris** buat nambah baris ke-3, isi 3 baris (`2200 Utang Bank` debit 1.500.000, `5500 Beban Bunga Bank` debit 200.000, `1200 Kas di Bank` kredit 1.700.000) — total debit dan kredit sama-sama 1.700.000, baru bisa disimpan.

## Langkah 3 — Buka detail journal entry

Klik salah satu baris entry di list (misal entry 7 Agustus yang barusan dibuat) — seluruh row clickable, navigasi ke `/journal-entries/[id]`. Yang muncul:

- Header: deskripsi (atau source_ref kalau deskripsi kosong) sebagai judul, tanggal di bawahnya.
- Card info: Tanggal, Deskripsi, Source Ref.
- Tabel **Journal Lines**: tiap baris akun + debit/kredit, dengan baris **Total** di footer tabel — bandingkan, total debit harus persis sama dengan total kredit (invariant `SUM(debit)=SUM(credit)` yang divalidasi RPC `create_journal_entry` pas Langkah 2 disimpan).

## Langkah 4 — Reversal (gap yang jujur harus dicatat)

Skema DB udah punya RPC `reverse_journal_entry` (bikin entry baru yang membalik debit↔kredit entry asli, nyimpen `reverses_entry_id`) — tapi **belum ada tombol apa pun di UI yang manggil RPC ini**, di list maupun di halaman detail `/journal-entries/[id]`. Jadi kamu gak akan nemu tombol "Reversal"/"Batalkan" buat diklik di sini — itu memang belum digarap, bukan sesuatu yang kamu lewatkan. Kalau nanti ditambah, sesuai aturan di `memory/preferences/ui/admin-shell-design.md` tombolnya wajib hidup di halaman detail (`/journal-entries/[id]`), bukan di row list.

Yang **udah** jalan di UI sekarang (bisa kamu lihat kalau ada data reversal, meski jalur bikinnya masih manual lewat SQL/RPC langsung): di list `/journal-entries`, entry yang punya `reverses_entry_id` keisi dapat badge kuning "Reversal" di sebelah deskripsinya. Di halaman detail entry itu, badge yang sama muncul di judul, plus link "Membalik entry: ..." yang klik-able balik ke entry aslinya. Entry asli yang **sudah** direversal, di detail page-nya sendiri dapat badge merah "Sudah Direversal" plus link "Dibalik oleh entry: ...". Jadi bagian *tampilan* pasangan reversal sudah lengkap — yang belum ada cuma tombol buat *memicu*-nya dari UI.

## Langkah 5 — Halaman General Ledger yang berdiri sendiri

Sidebar → grup **Accounting** → klik **General Ledger**. URL: `/general-ledger`. Beda dari tab Ledger di `/accounts/[id]` (lihat `docs/story/chart-of-accounts.md` Langkah 6) — di sini kamu **mulai dari halaman kosong** dan pilih akun sendiri lewat dropdown **Pilih akun** (isinya cuma leaf account, sama seperti dropdown di form Journal Entry).

Pilih `1200 — Kas di Bank`. Tabel yang muncul (Tanggal, Deskripsi, Source Ref, Debit, Kredit, Saldo Berjalan) harus persis sama datanya dengan tabel "Efek ke saldo" di atas — kalau kamu udah input ke-5 entry di Langkah 2 secara berurutan, saldo berjalan baris terakhir harus nunjukin **Rp10.800.000**.

## Lanjutan Story

Fase berikutnya (Accounts Receivable) bakal nagih Piutang Usaha dari Toko Kelontong Sumber Rejeki (entry 7 Agustus di atas) — pelunasannya jadi contoh transaksi pertama modul AR.
