# Financial Reports — Struktur Data

Konsep bisnisnya ada di `docs/domain/financial-reports.md`. Detail teknis: `supabase/migrations/0025_financial_reports_schema.sql`.

Struktur module → submodule di file ini SAMA urutannya dengan `docs/domain/financial-reports.md` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule").

**Migration final (2026-09-07):** `supabase/migrations/0025_financial_reports_schema.sql` —
konsolidasi dari migration incremental lama (sudah dihapus, historinya ada di `git log`).

## Peta Data (ERD) — Ringkasan Semua Tabel & Fungsi Laporan

Beda dari modul-modul pencatatan transaksi lainnya: Financial Reports **hampir gak menambah tabel baru**. Empat laporannya (Trial Balance, Income Statement, Balance Sheet, Cash Flow) semuanya dihitung on-demand dari 3 tabel yang sudah ada di Chart of Accounts dan General Ledger — cuma Tutup Buku (submodule terakhir) yang beneran nambah struktur baru.

| Nama | Jenis | Fungsi | Terhubung ke |
|---|---|---|---|
| `accounts` (sudah ada) | Tabel (dibaca) | Sumber daftar akun, kategori, dan arah saldo normal | — |
| `journal_entries` (sudah ada) | Tabel (dibaca) | Sumber tanggal transaksi — dasar filter "per tanggal" / "rentang tanggal" | — |
| `journal_lines` (sudah ada) | Tabel (dibaca) | Sumber angka debit/kredit mentah yang dijumlahkan per akun | `journal_entries` |
| Fungsi Trial Balance | Fungsi baca (bukan RPC/view) | Jumlahkan debit/kredit tiap akun sampai 1 tanggal, hasil saldo per akun | `accounts`, `journal_entries`, `journal_lines` |
| Fungsi Income Statement | Fungsi baca | Ambil akun Pendapatan+Beban dari Trial Balance, dibatasi rentang tanggal | Fungsi Trial Balance |
| Fungsi Balance Sheet | Fungsi baca | Ambil akun Aset+Liabilitas+Ekuitas dari Trial Balance di 1 tanggal + baris Laba Ditahan | Fungsi Trial Balance, Fungsi Income Statement |
| Fungsi Cash Flow | Fungsi baca | Bandingkan 2 Trial Balance + Laba Bersih dari Income Statement | Fungsi Trial Balance, Fungsi Income Statement |
| `period_closings` (baru) | Tabel (ditulis) | Daftar rentang tanggal yang sudah "disegel" lewat Tutup Buku | `journal_entries` (opsional, kalau ada closing entry) |
| Fungsi Tutup Buku (RPC) | RPC (financial write) | Nolkan saldo Pendapatan/Beban 1 rentang ke Laba Ditahan, kunci rentang itu | `accounts`, `journal_lines`, `period_closings` |

Laporan-laporan baca ini bisa dibayangkan sebagai **lapisan baca (read layer)** yang duduk di atas 3 tabel yang sudah ada — bukan entity baru yang berdiri sendiri.

## Trial Balance

**Peta Data (ERD)**

| Tabel/Fungsi | Fungsi | Terhubung ke |
|---|---|---|
| `accounts` | Daftar akun + kategori + arah saldo normal | — |
| `journal_lines` | Baris debit/kredit mentah, difilter sampai tanggal tertentu | `journal_entries` (buat tanggal) |
| Fungsi Trial Balance | Jumlahkan debit/kredit per akun, hasil saldo per akun di 1 titik waktu | `accounts`, `journal_lines` |

**Alur Teknis (RPC)**

| Aksi | Fungsi | Efek | Guard |
|---|---|---|---|
| Minta saldo semua akun per tanggal tertentu | Fungsi Trial Balance | Ambil semua `journal_lines` sampai tanggal itu, jumlahkan per akun, gabung ke `accounts` | Gak ada — murni baca, gak ada validasi input selain format tanggal |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Total debit = total kredit persis, gak ada toleransi | Konsekuensi otomatis dari aturan "setiap jurnal wajib balance" yang ditegakkan di General Ledger sejak baris pertama dicatat — Trial Balance cuma membuktikan ulang, gak menjamin dari nol |
| Saldo per akun dihitung dari arah saldo normal | Fungsi Trial Balance — debit dikurangi kredit kalau `normal_balance` akun itu debit, kebalikannya kalau kredit |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `journal_lines` | banyak-ke-satu | `journal_entries` (buat tanggal transaksi) |
| `journal_lines` | banyak-ke-satu | `accounts` (buat kategori & arah saldo normal) |

## Income Statement

**Peta Data (ERD)**

| Tabel/Fungsi | Fungsi | Terhubung ke |
|---|---|---|
| Fungsi Income Statement | Ambil akun kategori Pendapatan+Beban dari Fungsi Trial Balance, dibatasi rentang tanggal | Fungsi Trial Balance |
| `period_closings` | Sumber daftar entry penutup yang harus dikeluarkan dari perhitungan | `journal_entries` |

**Alur Teknis (RPC)**

| Aksi | Fungsi | Efek | Guard |
|---|---|---|---|
| Minta Laba Rugi 1 rentang tanggal | Fungsi Income Statement | Jalankan Fungsi Trial Balance dibatasi rentang, ambil akun Pendapatan+Beban, jumlahkan | Baris yang berasal dari entry penutup (lihat submodule "Tutup Buku") dikeluarkan sebelum dijumlahkan |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Income Statement selalu rentang tanggal, gak boleh snapshot 1 tanggal | Parameter fungsi mewajibkan tanggal awal DAN akhir, beda dari Trial Balance/Balance Sheet yang cuma 1 tanggal |
| Lihat ulang Laba Rugi periode yang sudah ditutup tetap nunjukin angka historis, bukan nol | Fungsi Income Statement secara eksplisit mengeluarkan baris entry penutup dari perhitungannya — Trial Balance sengaja TIDAK mengeluarkan (lihat submodule "Tutup Buku") |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| Fungsi Income Statement | memanggil | Fungsi Trial Balance |
| Fungsi Income Statement | mengecualikan baris dari | `period_closings.journal_entry_id` |

## Balance Sheet

**Peta Data (ERD)**

| Tabel/Fungsi | Fungsi | Terhubung ke |
|---|---|---|
| Fungsi Balance Sheet | Ambil akun Aset+Liabilitas+Ekuitas dari Fungsi Trial Balance di 1 tanggal, tambah 1 baris derived Laba Ditahan | Fungsi Trial Balance, Fungsi Income Statement |

**Alur Teknis (RPC)**

| Aksi | Fungsi | Efek | Guard |
|---|---|---|---|
| Minta Neraca per 1 tanggal | Fungsi Balance Sheet | (1) Jalankan Fungsi Trial Balance per tanggal itu. (2) Jalankan Fungsi Income Statement dari tanggal transaksi pertama sistem sampai tanggal itu, buat dapetin Laba Bersih. (3) Ambil akun Aset+Liabilitas+Ekuitas dari (1), tambah baris "Laba Ditahan" = Laba Bersih dari (2) | Validasi wajib: Total Aset = Total Liabilitas + Total Ekuitas setelah baris Laba Ditahan ditambahkan |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Laba Bersih wajib di-closing ke Laba Ditahan sebelum Balance Sheet dihitung | Fungsi Balance Sheet selalu memanggil Fungsi Income Statement dulu buat dapetin Laba Bersih sebelum menyusun baris Ekuitas |
| Akun kontra (Akumulasi Penyusutan) wajib dikurangkan dari Aset Tetap, bukan nilai perolehan mentah | Akun kontra otomatis bersaldo kredit dari arah saldo normalnya — tinggal dikurangkan pas ditampilkan di grup Aset |
| Asset = Liability + Equity harus selalu tegak | Kalau meleset, itu bug di query rollup (akun kelewat, atau closing Laba Ditahan lupa disertakan) — bukan toleransi pembulatan |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| Fungsi Balance Sheet | memanggil | Fungsi Trial Balance |
| Fungsi Balance Sheet | memanggil (buat baris Laba Ditahan) | Fungsi Income Statement |

## Cash Flow Statement

**Peta Data (ERD)**

| Tabel/Fungsi | Fungsi | Terhubung ke |
|---|---|---|
| Fungsi Cash Flow | Bandingkan 2 Trial Balance (awal & akhir periode) + Laba Bersih dari Income Statement | Fungsi Trial Balance (dipanggil 2x), Fungsi Income Statement |

**Alur Teknis (RPC)**

| Aksi | Fungsi | Efek | Guard |
|---|---|---|---|
| Minta Arus Kas 1 rentang tanggal (Metode Tidak Langsung) | Fungsi Cash Flow | (1) Fungsi Income Statement rentang itu → Laba Bersih. (2) Fungsi Trial Balance di tanggal awal-1 dan tanggal akhir → delta akun Piutang/Persediaan/Utang. (3) Add-back akun Beban Penyusutan. (4) Operating = Laba Bersih + add-back − ΔPiutang − ΔPersediaan + ΔUtang. (5) Investing/Financing dikelompokkan dari daftar akun yang diketahui (belum otomatis) | Validasi wajib: Kas Awal + Operating + Investing + Financing = Kas Akhir (harus sama persis dengan saldo akun Kas di Trial Balance akhir periode) |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Saldo Kas Akhir hasil hitungan wajib cocok ke saldo akun Kas Trial Balance sekarang | Ini validasi eksternal (dicek manual/di UI), bukan constraint yang mem-block — kalau gak cocok, bug ada di logic Fungsi Cash Flow, bukan di data |
| Metode Tidak Langsung dipilih, Metode Langsung belum didukung | Fungsi Cash Flow gak menerima kategori kas per baris — datanya emang gak ada kolom buat itu |
| Aktivitas non-kas (Investing/Financing) tetap didokumentasikan meski nilainya 0 di laporan | Ditampilkan sebagai catatan kaki terpisah di layer presentasi, bukan disembunyikan begitu nilainya nol |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| Fungsi Cash Flow | memanggil 2x (awal & akhir periode) | Fungsi Trial Balance |
| Fungsi Cash Flow | memanggil | Fungsi Income Statement |

## Tutup Buku (Period Closing)

Satu-satunya bagian di modul ini yang beneran **menulis** data (bukan cuma membaca) — mengunci sebuah rentang tanggal biar gak bisa disusupi transaksi baru lagi.

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `period_closings` | Daftar rentang tanggal yang sudah "disegel". Gak ada tabel "periode" dengan status terbuka/tertutup terpisah — sebuah tanggal dianggap "masih terbuka" kalau memang belum ada baris di sini yang mencakup tanggal itu | `journal_entries` (opsional, kalau ada entry penutup) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Tutup 1 rentang tanggal | Fungsi Tutup Buku | (1) Hitung ulang total Pendapatan dan Beban rentang itu langsung dari data mentah (bukan menerima angka dari luar). (2) Semua akun Pendapatan/Beban yang aktif di rentang itu dinolkan lewat 1 transaksi jurnal penutup, selisihnya (Laba/Rugi bersih) dipindahkan ke akun Laba Ditahan. (3) Rentang tanggal dicatat sebagai "tertutup" | Rentang harus berurutan & bersambung ke penutupan terakhir; gak boleh overlap; gak ada jalur reopen |
| Transaksi baru masuk ke rentang yang sudah tertutup | (trigger, bukan RPC terpisah) | Ditolak sebelum sempat tercatat | Tanggal transaksi dicek terhadap semua rentang di `period_closings` |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Transaksi baru gak boleh bertanggal masuk ke periode yang sudah ditutup | Trigger penolakan di titik pencatatan transaksi baru |
| Periode harus ditutup berurutan & tanpa jeda | Fungsi Tutup Buku — validasi rentang baru harus pas melanjutkan rentang terakhir yang sudah tertutup |
| Periode yang sudah ditutup gak bisa dibuka lagi | Sengaja gak ada RPC/aksi "reopen" sama sekali — koreksi cuma lewat transaksi baru di periode berjalan |
| Rentang tanpa aktivitas Pendapatan/Beban tetap bisa ditutup | Fungsi Tutup Buku gak mewajibkan ada jurnal penutup — kalau gak ada akun yang perlu dinolkan, rentang tetap dicatat tertutup tanpa transaksi jurnal apa pun |
| Angka yang ditutup gak boleh dimanipulasi dari luar | Fungsi Tutup Buku menghitung ulang sendiri dari data mentah, gak menerima nominal dari pemanggil |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `period_closings` | opsional, satu-ke-satu kalau ada penutupan beneran | `journal_entries` (entry penutup) |
| Income Statement | mengecualikan baris dari | `period_closings.journal_entry_id` |
| Trial Balance & Balance Sheet | TIDAK mengecualikan, ikut memperhitungkan | entry penutup dari `period_closings` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat semua 4 laporan | Semua user yang sudah login — sama seperti hak akses tab Ledger di halaman akun individual, gak ada pembatasan tambahan karena laporan cuma menggabungkan data yang sudah bisa dilihat per-akun |
| Menutup periode (tutup buku) | Role `admin` atau `accountant` |
