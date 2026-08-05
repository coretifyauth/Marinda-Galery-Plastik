# General Ledger & Journal Entry — Struktur Data

Fase 2. Konsep bisnisnya ada di `docs/domain/general-ledger.md` — file ini fokus ke struktur data & aturan otomatis. Detail teknis: `memory/architecture/data/journal-entry-schema.md`. Akun yang dipakai bergantung ke `docs/architecture/coa-schema.md`.

## Peta Data (ERD)

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `journal_entries` | Header 1 transaksi (tanggal, keterangan, dokumen sumber) | Bisa menunjuk ke entry lain yang dibalikkannya (reversing entry) |
| `journal_lines` | Baris debit/kredit dalam 1 transaksi | Setiap baris menunjuk ke 1 akun di Chart of Accounts |

**Struktur `journal_entries`:**

| Kolom | Isinya | Catatan |
|---|---|---|
| `entry_date` | Tanggal transaksi | |
| `description` | Keterangan | |
| `source_ref` | Referensi ke dokumen sumber (nota, invoice, dst) | **Wajib diisi** — setiap transaksi harus bisa ditelusuri ke buktinya |
| menunjuk ke entry lain | Kalau entry ini adalah pembalik dari entry lain | Diisi otomatis oleh sistem saat proses "batalkan/reverse", bukan manual |

**Struktur `journal_lines`:**

| Kolom | Isinya | Catatan |
|---|---|---|
| akun tujuan | Akun mana yang kena | Wajib akun "leaf" (paling bawah), gak boleh akun header |
| debit | Nilai di sisi debit | |
| kredit | Nilai di sisi kredit | Cuma satu dari debit/kredit yang boleh keisi per baris, gak boleh dua-duanya sekaligus |

## Aturan Otomatis yang Dijaga Sistem

Ini adalah jantung integritas keuangan seluruh aplikasi — semuanya ditegakkan otomatis oleh sistem, bukan sekadar konvensi yang harus diingat manual:

1. **Setiap transaksi harus balance.** Total debit harus sama persis dengan total kredit dalam satu transaksi — kalau tidak, sistem menolak transaksi itu seluruhnya (bukan cuma sebagian baris).
2. **Minimal 2 baris per transaksi.** Transaksi 1 baris gak ada gunanya secara akuntansi (gak ada pasangannya), jadi ditolak.
3. **Hanya akun paling bawah (leaf) yang boleh diposting.** Akun yang punya "anak" (akun header, misal "Kas" yang menaungi "Kas di Laci" + "Kas di Bank") gak boleh diposting langsung — mencegah saldo akun rollup jadi rancu/dobel hitung.
4. **Transaksi yang sudah tercatat tidak pernah bisa diedit atau dihapus.** Ini ditegakkan dua lapis: sistem menolak permintaan edit/hapus di level akses data, dan juga menolak lagi di level pemrosesan data — jadi meskipun satu lapis pengamanan gagal dikonfigurasi, lapisan kedua tetap menahan. Satu-satunya cara mengoreksi transaksi yang salah adalah membuat **entry pembalik** (reversing entry): entry baru dengan debit/kredit yang ditukar, ditautkan balik ke entry aslinya. Entry asli tetap ada selamanya di histori.
5. **Header dan semua barisnya masuk bersamaan, atau tidak sama sekali.** Tidak mungkin ada transaksi yang tersimpan header-nya tapi barisnya cuma separuh (misalnya kalau koneksi terputus di tengah proses) — semua-atau-tidak-sama-sekali.

## Aturan Tambahan pada Chart of Accounts (dampak dari modul ini)

Begitu modul ini dibangun, dua aturan tambahan ditambahkan ke tabel akun (`coa-schema.md`):
- Akun yang sudah pernah dipakai transaksi terkunci sebagian field-nya (lihat `docs/architecture/coa-schema.md`).
- Akun leaf yang sudah pernah diposting tidak bisa diam-diam berubah jadi header lewat penambahan akun anak baru — mencegah pelanggaran aturan "leaf-only posting" secara retroaktif terhadap histori yang sudah ada.

## Cara Kerja "Buat Transaksi" dan "Batalkan Transaksi"

Aplikasi tidak pernah menyimpan transaksi lewat langkah-langkah terpisah yang bisa gagal di tengah jalan. Dua alur berikut selalu diproses sebagai satu paket utuh:

- **Buat transaksi baru** — header + semua baris debit/kredit disimpan bersamaan, langsung tervalidasi (balance, leaf-only, dst) sebelum benar-benar tersimpan.
- **Balikkan transaksi** — sistem membaca transaksi asli, membuat transaksi baru dengan debit/kredit ditukar, dan menautkannya balik ke transaksi asli. Ini satu-satunya jalur "koreksi" yang tersedia di seluruh aplikasi.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat semua transaksi & saldo | Semua user yang sudah login |
| Membuat transaksi baru | Role `admin` atau `accountant` |
| Mengedit atau menghapus transaksi | **Tidak ada seorang pun** — hanya reversing entry yang diizinkan |

Penutupan periode (period closing) dan perhitungan saldo per akun (Trial Balance/Neraca) sudah dibangun — lihat `docs/architecture/financial-reports-schema.md`. Satu dampak balik ke modul ini: transaksi baru dengan tanggal yang jatuh di periode yang sudah ditutup otomatis ditolak.
