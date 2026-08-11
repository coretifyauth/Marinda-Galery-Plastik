# Story — Chart of Accounts: Toko Plastik Makmur Jaya

Fase 1. Konteks bisnis lengkap: `docs/story/company-profile.md`. Konsep COA: `docs/domain/chart-of-accounts.md`. Schema: `memory/architecture/data/coa-schema.md`.

Beda dari versi lama file ini — sekarang ditulis sebagai **tutorial klik-per-klik di UI beneran**, bukan cuma cerita di atas kertas. Jalankan app-nya (`apps/erp`), login sebagai Pak Herman, terus ikutin langkah di bawah sambil beneran klik.

## Daftar Akun Pak Herman

Ini COA yang dipakai buat Toko Plastik Makmur Jaya, disusun dari kebutuhan bisnisnya (retail + grosir, bukan template generik):

```
1000 Kas                              (header)
├── 1100 Kas Toko                     — laci kasir POS, cash/QRIS harian dipegang Mbak Rina
└── 1200 Kas di Bank                  — rekening operasional Pak Herman
1300 Piutang Usaha                    — tagihan ke 3 pelanggan grosir langganan
1400 Persediaan Barang Dagang         — ember, kursi, rak, piring, gelas, dst
1600 Aset Tetap                       (header)
├── 1610 Mobil Pickup Antar Barang    — dibeli 2024 pakai pinjaman bank
└── 1620 Rak Display Toko             — dibeli 2023

2100 Utang Usaha                      — utang ke PT Plastindo Jaya & CV Sumber Plastik
2200 Utang Bank                       — cicilan pinjaman beli mobil pickup

3100 Modal Pemilik
3200 Laba Ditahan

4100 Pendapatan Penjualan Toko        — jual langsung ke pembeli umum di ruko
4200 Pendapatan Penjualan Grosir      — jual ke 3 pelanggan grosir langganan

5100 Harga Pokok Penjualan            — HPP barang plastik terjual
5200 Beban Gaji Karyawan              — gaji Mbak Rina
5300 Beban Sewa Ruko
5400 Beban Listrik dan Air
5500 Beban Bunga Bank                 — bunga cicilan pinjaman mobil pickup
```

**Kenapa dipisah gini:**
- `1000 Kas` jadi header karena Pak Herman butuh 2 kebutuhan beda: kas fisik di laci kios (rekonsiliasi harian sama Mbak Rina) vs saldo bank (transfer ke supplier, cek cicilan) — tapi kadang Pak Herman cuma mau tau "kas total berapa", makanya di-rollup ke `1000`.
- `4100` vs `4200` dipisah karena marginnya beda — jual retail harga normal, jual grosir ke 3 pelanggan langganan ada potongan harga. Pak Herman perlu tau mana yang lebih untung.
- **Sengaja gak** dibikin akun kas per-cabang atau per-hari — cuma 1 toko fisik, itu common mistake over-granular yang disebut di `docs/domain/chart-of-accounts.md`.
- **Belum ada** akun "Akumulasi Penyusutan" untuk Mobil Pickup/Rak Display di daftar di atas — itu dipasang lewat modul Fixed Assets (lihat bagian "Akun Kontra" di bawah), bukan dibuat manual lewat form COA ini.

## Langkah 1 — Buka Chart of Accounts

Sidebar kiri → grup **Accounting** (icon Calculator, klik label buat expand kalau masih collapsed) → klik **Chart of Accounts**. URL: `/accounts`.

Yang harus muncul: tabel akun berbentuk tree (indentasi sesuai `parent_id`), kolom Kode/Nama/Kategori/Normal Balance, toolbar di atas tabel nunjukin judul list + jumlah akun. Kalau seed COA di atas udah jalan, cari `1600 Aset Tetap` — harusnya punya 2 anak (`1610`, `1620`) yang keindent ke kanan.

## Langkah 2 — Filter list by kategori

Klik tombol **Filter** di toolbar (kanan atas tabel, sebelah Refresh). Muncul baris filter di bawah toolbar dengan dropdown **Kategori**. Pilih `liability` — tabel harusnya cuma nyisain `2100 Utang Usaha` dan `2200 Utang Bank`. Balikin ke `Semua` buat lihat semua akun lagi.

## Langkah 3 — Tambah akun baru

Klik **+ New** (tombol biru di toolbar, cuma muncul kalau role kamu `admin`/`accountant` — Pak Herman punya `admin`). Form "Tambah Akun" muncul di bawah tabel, isi:

- **Kode**: `5600`
- **Nama akun**: `Beban Pemeliharaan Kendaraan`
- **Kategori**: pilih `expense` dari dropdown
- **Akun induk**: biarin `Tanpa parent (header baru)` — ini bakal jadi leaf langsung di root, bukan child dari akun lain

Klik **Simpan**. Perhatikan: kamu **gak pernah isi `normal_balance` manual** — field itu gak ada di form sama sekali, karena `normal_balance` derived otomatis dari `category` (`expense` → `debit`). Setelah simpan, scroll tabel — `5600 Beban Pemeliharaan Kendaraan` muncul dengan kolom Normal Balance = `debit`, tanpa kamu pernah isi itu.

Coba juga bikin child account: ulangi form, **Kode** `1611`, **Nama** `Sparepart Mobil Pickup`, **Kategori** `asset`, **Akun induk** pilih `1610 — Mobil Pickup Antar Barang`. Setelah simpan, `1611` muncul terindent di bawah `1610` — itu hierarki lewat `parent_id`, bukan kolom "level" terpisah.

## Langkah 4 — Klik ke Account Detail

Klik salah satu baris akun (misal `1300 Piutang Usaha`) — seluruh row clickable, navigasi ke `/accounts/[id]`. Yang muncul di detail:

- Header: kode + nama akun, badge kategori, badge "Normal debit/credit", badge "Diarsipkan" kalau ada.
- Tab **Detail** (default aktif) — field Kode, Nama, Kategori, Normal Balance, Akun Induk, Status, ditampilkan read-only (`<dl>`, bukan form input).
- Tab **Ledger** — histori transaksi akun ini (lihat Langkah 6).

**Gap yang jujur harus dicatat**: halaman detail ini **belum punya form edit** — semua field cuma ditampilin, gak ada tombol "Save"/"Edit" di mana pun untuk akun. Jadi walau field kritikal (`code`, `category`, `normal_balance`, `parent_id`, `is_contra`) secara desain terkunci begitu akun dipakai di jurnal (`accounts_published_lock` trigger, DB-level) dan `name`/`archived_at` secara desain masih bebas diubah, saat ini **gak ada jalur UI buat beneran ubah nama atau arsipkan akun** — itu baru bisa lewat SQL langsung. Kalau kamu nemuin ini pas jalan-jalan di UI, itu memang belum digarap, bukan bug yang kamu lewatkan.

## Langkah 5 — Lihat published-lock kerja (lewat jurnal, bukan lewat form edit)

Karena belum ada form edit, cara paling konkret buat "ngerasain" published-lock adalah lewat banner di detail page. Buka akun yang **udah pernah dipakai** di journal entry (setelah kamu ikutin `docs/story/general-ledger.md` dan bikin minimal 1 entry yang nyentuh, misal, `1200 Kas di Bank`), balik ke `/accounts/[id]` akun itu, tab **Detail** — bakal muncul banner kuning:

> 🔒 Akun ini sudah dipakai di jurnal — code/category/normal_balance/parent_id/is_contra terkunci (`accounts_published_lock`). Cuma `name`/`archived_at` yang masih bisa diubah.

Akun yang **belum pernah** dipakai (baru dibuat, misal `5600` dari Langkah 3) gak nampilin banner ini — itu bedanya "belum published" vs "udah published".

## Langkah 6 — Tab Ledger di Account Detail

Masih di `/accounts/[id]` akun yang sudah punya transaksi (misal `1200 Kas di Bank`), klik tab **Ledger**. Tabelnya nunjukin Tanggal, Deskripsi, Source Ref, Debit, Kredit, dan **Saldo Berjalan** (running balance, dihitung client-side dari urutan tanggal). Header halaman di atas tab juga nunjukin saldo akhir akun itu di pojok kanan atas — harus sama persis dengan baris terakhir kolom Saldo Berjalan di tab Ledger.

Ini tab yang sama fungsinya kayak halaman `/general-ledger` yang berdiri sendiri (lihat `docs/story/general-ledger.md`) — bedanya di sini kamu udah "masuk" dari sisi akunnya (gak perlu pilih dari dropdown lagi).

## Langkah 7 — Coba pelanggaran leaf-only posting

Aturan: cuma akun **leaf** (gak punya child) yang boleh diposting transaksi — akun header (`1000 Kas`, `1600 Aset Tetap`) cuma nampung rollup. Balik ke Chart of Accounts (`/accounts`), lalu buka `/journal-entries` (lihat `docs/story/general-ledger.md` buat detail form-nya) — begitu kamu klik dropdown **Akun** di baris jurnal, `1000 Kas` dan `1600 Aset Tetap` **gak akan muncul di pilihan sama sekali**, cuma leaf account (`1100`, `1200`, `1300`, dst) yang kelihatan. Dropdown-nya udah difilter di client (`getLeafAccounts`), jadi kamu gak bisa salah pilih dari form manapun — trigger DB `journal_lines_leaf_only` cuma jadi jaring pengaman kalau ada yang nembak lewat RPC/SQL langsung, bukan sesuatu yang bisa kamu picu dari UI.

## Akun Kontra (is_contra) — kenapa gak ada di form "+ New"

Badge "Kontra" muncul di header detail page kalau `is_contra = true` (contoh nantinya: `Akumulasi Penyusutan Mobil Pickup`, contra dari `1610`). Tapi coba cek lagi form Langkah 3 — **gak ada field `is_contra` di sana sama sekali**. Itu bukan kelewatan nulis dokumen ini: `is_contra` cuma diset lewat modul Fixed Assets (posting depresiasi pertama kali otomatis bikin akun kontra-nya kalau belum ada) atau langsung lewat migration/SQL, bukan lewat form Chart of Accounts biasa — karena akun kontra butuh dipasangkan sama akun induknya secara sengaja, bukan sesuatu yang aman dibiarkan user pilih bebas dari dropdown kategori umum.

## Lanjutan Story

Fase berikutnya (General Ledger + Journal Entries) bakal nulis transaksi pertama Toko Plastik Makmur Jaya (setoran modal, jual retail, kirim ke pelanggan grosir) yang posting ke akun-akun di atas. File: `docs/story/general-ledger.md`.
