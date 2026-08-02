# Accounts Payable — Struktur Data

Fase 4. Konsep bisnisnya ada di `docs/domain/accounts-payable.md`. Skenario nyata: `docs/story/accounts-payable.md`. Detail teknis: `memory/architecture/data/ap-schema.md`. Strukturnya cerminan persis dari Accounts Receivable (`docs/architecture/ar-schema.md`), arah kebalik — di sini kita yang berutang, bukan piutang.

## Peta Data (ERD)

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `suppliers` | Master data pemasok (nama, kontak, termin pembayaran) | — |
| `ap_bills` | Tagihan yang diterima dari pemasok | `suppliers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ap_payments` | Pembayaran yang dikirim ke pemasok | `suppliers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ap_payment_allocations` | Jembatan: "pembayaran X melunasi bill Y sejumlah Z" | Menghubungkan `ap_payments` ↔ `ap_bills` |

Satu perbedaan penting dari AR: kolom termin pembayaran di sini artinya kebalik — di Piutang, kita yang menetapkan termin ke pelanggan; di Utang, pemasok yang menetapkan termin ke kita. Kolom & cara kerjanya identik, cuma makna bisnisnya kebalik.

**Struktur `ap_bills`:**

| Kolom | Isinya | Catatan |
|---|---|---|
| pemasok | Ke siapa kita berutang | |
| tanggal bill, jatuh tempo | Kapan diterima, kapan harus dibayar | Jatuh tempo dihitung sekali dari termin pemasok **saat bill dicatat**, lalu disimpan permanen |
| jumlah | Nilai tagihan | |
| status (lunas/sebagian/belum/dibatalkan) | — | **Tidak disimpan**, selalu dihitung ulang dari total pembayaran yang sudah dialokasikan |

Beda dari invoice AR yang sisi debitnya selalu tetap (Piutang Usaha), bill AP bisa didebit ke akun yang berbeda-beda tergantung jenis pembelian — bisa ke Persediaan (beli bahan baku) atau ke Beban (beli jasa/sewa/listrik). Akun tujuan debit ini dipilih setiap kali bill dibuat.

## Aturan Otomatis yang Dijaga Sistem

Sama persis dengan Accounts Receivable, arah kebalik:

1. **Alokasi pembayaran tidak boleh melebihi yang tersedia** — baik terhadap sisa utang di satu bill, maupun terhadap sisa dana yang belum dipakai dari satu pembayaran.
2. **Bill dan pembayaran tidak pernah bisa diedit atau dihapus** (dua lapis pengamanan). Data pemasok (nama, kontak, termin) boleh diubah kapan saja.
3. **Bill hanya bisa dibatalkan kalau belum ada pembayaran yang mengalokasikan ke situ** — pengaman ini diterapkan sejak awal di modul AP (di AR, pengaman yang sama baru ditambahkan belakangan setelah terbukti dibutuhkan).
4. **Setiap bill dan pembayaran otomatis membuat transaksi jurnal yang sepadan** — dijamin lewat proses gabungan yang sama seperti di AR.

## Cara Kerja "Buat Bill", "Catat Pembayaran", dan "Batalkan Bill"

- **Buat bill** — sistem menghitung tanggal jatuh tempo dari termin pemasok, membuat transaksi jurnal (Debit akun yang dipilih — Persediaan atau Beban, Kredit Utang Usaha), lalu mencatat bill yang menunjuk ke transaksi jurnal itu — satu langkah gabungan.
- **Catat pembayaran** — sistem membuat transaksi jurnal (Debit Utang Usaha, Kredit Kas/Bank), mencatat pembayarannya, lalu mengalokasikan ke satu atau beberapa bill sekaligus — satu langkah gabungan.
- **Batalkan bill** — sama seperti pembatalan invoice AR: dicek dulu belum ada pelunasan, lalu dibuat transaksi pembalik memakai akun yang sama persis dengan bill aslinya.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pemasok, bill, pembayaran | Semua user yang sudah login |
| Menambah pemasok baru, mengubah data pemasok | Role `admin` atau `accountant` |
| Membuat bill atau mencatat pembayaran | Role `admin` atau `accountant` |
| Mengedit atau menghapus bill/pembayaran | **Tidak ada seorang pun** — hanya pembatalan lewat reversing entry yang diizinkan |
| Menghapus data pemasok secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan |

## Belum Termasuk

- **Retur barang ke pemasok** — kasus bill perlu dikurangi karena barang dikembalikan ke pemasok.
- **Diskon bayar cepat (early payment discount)** — kasus ini tidak ada padanannya di AR; pemasok kadang menawarkan potongan harga kalau dibayar lebih awal dari jatuh tempo.
- **Uang muka/DP ke pemasok** — pembayaran di muka sebelum ada bill resmi.
- **Bill dengan kategori campuran (compound)** — satu nota pemasok yang isinya campuran, misalnya sebagian barang (masuk Persediaan) dan sebagian ongkos kirim (langsung Beban), dalam satu bill yang sama.
