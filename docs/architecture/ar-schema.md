# Accounts Receivable — Struktur Data

Fase 3. Konsep bisnisnya ada di `docs/domain/accounts-receivable.md`. Skenario nyata: `docs/story/accounts-receivable.md`. Detail teknis: `memory/architecture/data/ar-schema.md`.

## Peta Data (ERD)

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `customers` | Master data pelanggan (nama, kontak, termin pembayaran) | — |
| `ar_invoices` | Tagihan yang diterbitkan ke pelanggan | `customers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ar_payments` | Pembayaran yang diterima dari pelanggan | `customers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ar_payment_allocations` | Jembatan: "pembayaran X melunasi invoice Y sejumlah Z" | Menghubungkan `ar_payments` ↔ `ar_invoices` |

Kenapa perlu tabel jembatan (`ar_payment_allocations`) — bukan cukup satu invoice satu pembayaran: satu pembayaran bisa melunasi beberapa invoice sekaligus (bayar gabungan), dan satu invoice bisa dilunasi lewat beberapa pembayaran (dicicil). Hubungannya banyak-ke-banyak, jadi butuh tabel sendiri yang mencatat tiap pasangan pembayaran-invoice beserta jumlahnya.

**Struktur `ar_invoices`:**

| Kolom | Isinya | Catatan |
|---|---|---|
| pelanggan | Siapa yang berutang | |
| tanggal invoice, jatuh tempo | Kapan diterbitkan, kapan harus lunas | Jatuh tempo dihitung sekali dari termin pelanggan **saat invoice dibuat**, lalu disimpan permanen — kalau termin pelanggan berubah belakangan, invoice lama tidak ikut berubah |
| jumlah | Nilai tagihan | |
| status (lunas/sebagian/belum/dibatalkan) | — | **Tidak disimpan**, selalu dihitung ulang dari total pembayaran yang sudah dialokasikan dibanding nilai invoice |

## Aturan Otomatis yang Dijaga Sistem

1. **Alokasi pembayaran tidak boleh melebihi yang tersedia.** Sistem menolak alokasi yang membuat total pelunasan sebuah invoice melebihi nilai invoice itu, atau yang membuat total penggunaan sebuah pembayaran melebihi jumlah uang yang diterima.
2. **Invoice dan pembayaran tidak pernah bisa diedit atau dihapus** — sama seperti transaksi jurnal biasa (dua lapis pengamanan). Data pelanggan sendiri (nama, kontak, termin) boleh diubah kapan saja karena itu bukan catatan transaksi, cuma master data.
3. **Invoice hanya bisa dibatalkan kalau belum ada pembayaran yang mengalokasikan ke situ.** Kalau sudah ada pelunasan (meski sebagian), pembatalan lewat jalur biasa ditolak — harus ditangani lewat proses yang lebih hati-hati (di luar cakupan saat ini).
4. **Setiap invoice dan pembayaran otomatis membuat transaksi jurnal yang sepadan** — tidak mungkin ada invoice tanpa jurnal Piutang/Pendapatan, atau pembayaran tanpa jurnal Kas/Piutang. Ini dijamin karena satu-satunya cara membuat invoice/pembayaran adalah lewat proses gabungan yang disebut di bawah.

## Cara Kerja "Buat Invoice", "Catat Pembayaran", dan "Batalkan Invoice"

- **Buat invoice** — sistem menghitung tanggal jatuh tempo dari termin pelanggan, membuat transaksi jurnal (Debit Piutang Usaha, Kredit Pendapatan), lalu mencatat invoice yang menunjuk ke transaksi jurnal itu — semua sebagai satu langkah gabungan.
- **Catat pembayaran** — sistem membuat transaksi jurnal (Debit Kas/Bank, Kredit Piutang Usaha) untuk total yang dibayar, mencatat pembayarannya, lalu mengalokasikan jumlah itu ke satu atau beberapa invoice sekaligus (bisa bayar gabungan atau cicilan) — semua dalam satu langkah gabungan.
- **Batalkan invoice** — sistem memeriksa dulu apakah invoice sudah punya pelunasan; kalau belum, sistem membuat transaksi pembalik (debit/kredit ditukar) memakai akun yang sama persis dengan invoice aslinya. Invoice aslinya sendiri tidak diubah sama sekali — status "dibatalkan" murni dibaca dari keberadaan transaksi pembalik itu.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pelanggan, invoice, pembayaran | Semua user yang sudah login |
| Menambah pelanggan baru, mengubah data pelanggan | Role `admin` atau `accountant` |
| Membuat invoice atau mencatat pembayaran | Role `admin` atau `accountant` |
| Mengedit atau menghapus invoice/pembayaran | **Tidak ada seorang pun** — hanya pembatalan lewat reversing entry yang diizinkan |
| Menghapus data pelanggan secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan |

## Belum Termasuk

- **Retur barang dari pelanggan (credit note)** — kasus invoice perlu dikurangi/dibatalkan sebagian karena barang dikembalikan, butuh desain entitas baru.
- **Uang muka/DP dari pelanggan sebelum ada invoice** — saat ini setiap pembayaran wajib langsung dialokasikan ke invoice yang sudah ada.
- **Kelebihan bayar (overpayment) sebagai saldo kredit pelanggan** — saat ini sistem menolak keras alokasi yang melebihi nilai invoice, belum ada tempat menampung kelebihannya untuk dipakai di invoice berikutnya.
- **Laporan umur piutang (aging) / dashboard invoice jatuh tempo** — ini laporan baca-saja dari data yang sudah ada, akan dibangun bersama tampilan UI-nya, tidak butuh perubahan struktur data.
