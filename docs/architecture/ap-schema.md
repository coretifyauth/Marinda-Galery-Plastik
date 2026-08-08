# Accounts Payable — Struktur Data

Fase 4. Konsep bisnisnya ada di `docs/domain/accounts-payable.md`. Skenario nyata: `docs/story/accounts-payable.md`. Detail teknis: `memory/architecture/data/ap-schema.md`. Strukturnya cerminan persis dari Accounts Receivable (`docs/architecture/ar-schema.md`), arah kebalik — di sini kita yang berutang, bukan piutang.

## Peta Data (ERD)

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `suppliers` | Master data pemasok (nama, kontak, termin pembayaran) | — |
| `ap_bills` | Tagihan yang diterima dari pemasok | `suppliers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ap_payments` | Pembayaran yang dikirim ke pemasok — selalu menunjuk 1 bill spesifik, boleh cicil (1 bill bisa punya banyak pembayaran), gak boleh kelebihan bayar | `suppliers`, `ap_bills` (banyak-ke-satu), dan ke transaksi jurnal yang otomatis dibuat |
| `ap_credit_notes` | Retur barang ke pemasok, jalur "kurangi utang" (Opsi A) | `ap_bills`, dan ke transaksi jurnal yang otomatis dibuat |
| `purchase_return_lines` | Rincian barang yang diretur per item (cuma kalau bill-nya diterima lewat penerimaan barang bertahap) | `ap_credit_notes` |
| `purchase_replacements` + `purchase_replacement_lines` | Tukar barang rusak dengan barang baik dari pemasok, jalur "tukar barang" (Opsi B) — **berdiri sendiri**, tidak menyambung ke `ap_credit_notes` | `ap_bills` |
| `ap_return_credits` | Saldo "Piutang Retur Pemasok" — muncul otomatis kalau Opsi A dipakai pada bill yang sudah lunas | `ap_credit_notes` |
| `ap_return_credit_refunds` | Saldo di atas dicairkan tunai (satu-satunya disposisi — "dipakai motong bill lain" dicabut 2026-08-08, bukan fondasi AP) | `ap_return_credits` |
| `ap_deposits` | Uang muka yang kita bayar ke pemasok sebelum ada bill — asset "Uang Muka Pembelian" (kebalikan AR: di AR itu liability, di sini asset karena pemasok yang "berutang" balik ke kita) | `suppliers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ap_deposit_applications` | DP di atas diterapkan ke bill yang sudah diterbitkan | `ap_deposits`, `ap_bills` |
| `ap_deposit_refunds` | DP dicairkan tunai kembali (pemasok yang mutuskan, bukan kita) — tidak berdampak Laba Rugi | `ap_deposits` |
| `ap_deposit_forfeitures` | DP dianggap hangus (pemasok tidak mau/tidak bisa balikin) — jadi Beban Kerugian Uang Muka | `ap_deposits` |

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

1. **Pembayaran boleh kurang dari sisa tagihan bill (cicil), tapi gak boleh lebih.** Sistem menolak keras kalau nominalnya melebihi sisa outstanding (coba kelebihan bayar) — gak ada ruang buat kelebihan yang "nyantol". Cicilan boleh; bayar gabungan (1 pembayaran nutup beberapa bill sekaligus) tidak — setiap pembayaran selalu menunjuk 1 bill spesifik.
2. **Bill dan pembayaran tidak pernah bisa diedit atau dihapus** (dua lapis pengamanan). Data pemasok (nama, kontak, termin) boleh diubah kapan saja.
3. **Bill hanya bisa dibatalkan kalau belum ada pembayaran yang mengalokasikan ke situ** — pengaman ini diterapkan sejak awal di modul AP (di AR, pengaman yang sama baru ditambahkan belakangan setelah terbukti dibutuhkan).
4. **Setiap bill dan pembayaran otomatis membuat transaksi jurnal yang sepadan** — dijamin lewat proses gabungan yang sama seperti di AR.

## Cara Kerja "Buat Bill", "Catat Pembayaran", dan "Batalkan Bill"

- **Buat bill** — sistem menghitung tanggal jatuh tempo dari termin pemasok, membuat transaksi jurnal (Debit akun yang dipilih — Persediaan atau Beban, Kredit Utang Usaha), lalu mencatat bill yang menunjuk ke transaksi jurnal itu — satu langkah gabungan.
- **Catat pembayaran** — pemasok wajib pilih 1 bill, dan nominalnya boleh kurang dari sisa tagihan (cicil) tapi gak boleh lebih. Sistem membuat transaksi jurnal (Debit Utang Usaha, Kredit Kas/Bank) untuk nominal itu dan mencatat pembayarannya langsung menunjuk ke bill itu — satu langkah gabungan, ditolak keras cuma kalau nominalnya melebihi sisa.
- **Batalkan bill** — sama seperti pembatalan invoice AR: dicek dulu belum ada pelunasan, lalu dibuat transaksi pembalik memakai akun yang sama persis dengan bill aslinya. Sejak fitur retur ada, ada pengecekan tambahan: bill yang sudah pernah diretur (Opsi A) **tidak bisa** dibatalkan lewat jalur ini (sama alasan bill yang sudah ada pelunasan — sudah "tersentuh" transaksi lain).

## Retur Barang ke Pemasok — 2 Jalur, Dipilih Manual

Begitu barang rusak dari pemasok ketauan, orang yang input transaksi harus pilih **salah satu** dari 2 jalur resolusi (sama seperti milih akun debit Persediaan vs Beban saat bikin bill — keputusan bisnis manusia, bukan hasil deteksi sistem otomatis):

- **Opsi A — Kurangi Utang**
  - Bill belum lunas/sebagian → jurnal langsung mengurangi Utang Usaha, tanpa lewat akun perantara (beda dari AR yang pakai akun kontra "Retur & Potongan Penjualan" — di sini Persediaan boleh langsung dikurangi karena itu akun neraca, bukan akun pendapatan).
  - Bill sudah lunas penuh → jurnal yang sama tetap jalan (utang jadi minus sesaat), lalu kelebihannya otomatis dipindah jadi saldo baru **Piutang Retur Pemasok** — pemasok yang sekarang "berutang" balik ke kita. Saldo ini dicairkan tunai (satu-satunya cara — opsi "dipakai motong bill lain" sempat ada, dicabut karena bukan fondasi AP).
- **Opsi B — Tukar Barang**
  - Berlaku sama persis di semua status bayar — Utang Usaha **tidak pernah tersentuh**, baik bill-nya lunas, sebagian, maupun belum dibayar sama sekali.
  - Barang rusak keluar, barang baik masuk sejumlah sama — murni pemindahan pencatatan Persediaan, tidak ada nilai yang hilang atau bertambah.
  - **Sengaja tidak menyambung ke Opsi A** (beda dari fitur serupa di AR yang mewajibkan retur dulu baru penggantian barang) — kalau kedua opsi dipaksa jalan bareng untuk 1 kejadian rusak yang sama, pemasok jadi memberi 2 kompensasi sekaligus, yang tidak masuk akal secara bisnis.

Catatan implementasi: fitur ini untuk sekarang baru menangani barang dengan metode pencatatan biaya Rata-Rata Tertimbang — lihat "Belum Termasuk".

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pemasok, bill, pembayaran | Semua user yang sudah login |
| Menambah pemasok baru, mengubah data pemasok | Role `admin` atau `accountant` |
| Membuat bill atau mencatat pembayaran | Role `admin` atau `accountant` |
| Mengedit atau menghapus bill/pembayaran | **Tidak ada seorang pun** — hanya pembatalan lewat reversing entry yang diizinkan |
| Menghapus data pemasok secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan |

## Belum Termasuk

- **Diskon bayar cepat (early payment discount)** — kasus ini tidak ada padanannya di AR; pemasok kadang menawarkan potongan harga kalau dibayar lebih awal dari jatuh tempo.
- **Bill dengan kategori campuran (compound)** — satu nota pemasok yang isinya campuran, misalnya sebagian barang (masuk Persediaan) dan sebagian ongkos kirim (langsung Beban), dalam satu bill yang sama.
- **Batas waktu retur ke pemasok** — belum ada batas hari sejak barang diterima untuk boleh diretur. AR sendiri sempat punya validasi serupa tapi udah dicabut total (lihat `docs/domain/accounts-receivable.md`).
- **Barang rusak yang pemasok tolak ganti sama sekali** — kasus lintas modul (berlaku juga di AR): barang rusak tanpa kompensasi apa pun dari pihak lain seharusnya diakui sebagai kerugian murni, bukan lewat jalur retur.
