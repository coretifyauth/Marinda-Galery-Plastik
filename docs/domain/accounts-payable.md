# Accounts Payable — Bayar Utang ke Supplier

## Masalah yang diselesaikan

Fase 2 (`general-ledger.md`) udah bisa nyatet utang timbul (Kredit Utang Usaha) pas beli bahan baku belum bayar — entry 10 Juli, beli tepung & gula Rp800.000. Tapi sama kayak sebelum AR ada, itu baru "kejadiannya kecatet" — belum ada mekanisme buat tau **siapa** supplier-nya, **kapan jatuh tempo**, dan **udah dibayar berapa**. AP (Accounts Payable) nutup gap ini dari sisi kebalikan AR: sekarang **CV Barokah** yang berutang, bukan yang piutang.

## Kenapa Beda dari AR (bukan cuma tukar arah)

Struktur tabelnya mirror persis AR (`docs/domain/accounts-receivable.md`), tapi ada 1 perbedaan konteks bisnis yang penting:

- **Di AR**, CV Barokah yang nentuin `payment_term_days` buat customer (Bu Nur ngasih syarat termin ke warung langganan).
- **Di AP**, kebalikannya — **supplier** yang nentuin termin, CV Barokah cuma nerima syarat itu. `payment_term_days` di tabel `suppliers` maknanya "syarat yang diterima dari supplier", bukan "syarat yang kita tetapkan sendiri".

Bedanya cuma di makna bisnis, bukan di struktur data — kolomnya tetap sama.

## Konsep Inti

- **Supplier** — master data, pihak yang CV Barokah berutang ke dia (2 supplier bahan baku langganan). Punya `payment_term_days` (syarat dari supplier, bukan kita yang nentuin) yang dipakai ngitung jatuh tempo tiap bill baru. Bukan data transaksional — kalau terminnya berubah (misal supplier naikin kepercayaan jadi termin lebih panjang), di-`UPDATE` di baris yang sama, gak bikin row baru (sama alasan `customers` di AR).
- **AP Bill** — utang timbul. 1 kejadian "ambil barang, belum bayar" = 1 bill. Tiap bill bikin 1 journal entry: **Debit Persediaan/Beban (tergantung jenis pembelian), Kredit Utang Usaha**. `due_date` dihitung otomatis (`bill_date + payment_term_days` supplier itu) **pas bill dibuat**, disimpan permanen.
- **AP Payment** — utang berkurang, kejadian bayar beneran ke supplier (bukan jadwal). 1 payment bikin 1 journal entry: **Debit Utang Usaha, Kredit Kas/Bank**, sejumlah total yang dibayar — gak peduli nutup 1 atau banyak bill.
- **AP Payment Allocation** — jembatan many-to-many antara payment dan bill, sama alasan `ar_payment_allocations`: CV Barokah sering bayar gabungan beberapa bill sekaligus, atau nyicil 1 bill bertahap.
- **Status bill** (lunas/sebagian/belum/dibatalkan) — derived dari `SUM(allocations.amount)` dibanding `bill.amount`, ditambah cek reversal journal entry buat status "dibatalkan". Bukan kolom manual, pola sama persis AR.

## Retur Barang ke Supplier

Kebalikan AR Credit Note (`docs/domain/accounts-receivable.md` bagian "Retur Barang") — bahan baku yang diterima dari supplier ternyata rusak (misal tepung apek, gula basah kena air), dan Barokah mau kembalikan. Bedanya dari `cancel_ap_bill`: bill-nya **valid**, transaksinya beneran kejadian, cuma **sebagian barangnya** dikembalikan belakangan — bisa kejadian kapan pun, baik bill belum dibayar, sebagian, atau udah lunas penuh.

Begitu barang rusak ketauan, ada **2 resolusi** yang bisa disepakati sama supplier — pilihan manual orang yang input transaksi (sama pola milih akun debit Persediaan vs Beban di `create_ap_bill`, keputusan bisnis manusia, bukan hasil deteksi sistem), **bukan konsekuensi otomatis dari status bayar bill**:

- **Opsi A — Kurangi Utang** (retur beneran ngurangin Utang Usaha)
  - **Bill belum lunas/sebagian**: Debit Utang Usaha / Kredit Persediaan Bahan Baku — utang beneran berkurang. Contoh: bill Rp1.200.000 belum dibayar, retur Rp180.000 → sisa utang jadi Rp1.020.000.
  - **Bill udah lunas penuh** (atau retur ngelebihin sisa outstanding): jurnal yang sama tetap jalan dulu (bikin outstanding minus) → excess-nya **otomatis** direklasifikasi jadi saldo baru **Piutang Retur Supplier** (akun asset baru) — mirror `ar_return_credits` di AR, tapi arah aset kebalik (di AR itu liability kita ke customer; di sini asset kita ke supplier, karena supplier yang "berutang" balik ke kita). Saldo ini partial-capable, bisa:
    - **Dipakai motong bill lain** ke supplier yang sama (Debit Utang Usaha / Kredit Piutang Retur Supplier).
    - **Dicairkan tunai** (Debit Kas/Bank / Kredit Piutang Retur Supplier).
  - **Kenapa gak butuh akun kontra** (beda dari AR yang pakai kontra-revenue "Retur & Potongan Penjualan"): sisi debit bill (Persediaan Bahan Baku) itu akun **neraca** (asset), bukan akun laporan laba-rugi kayak Pendapatan — retur boleh langsung mengurangi Persediaan tanpa lewat akun perantara.
- **Opsi B — Tukar Barang** (supplier kirim barang pengganti, bukan kurangin utang)
  - **Berdiri sendiri, gak lewat retur Opsi A sama sekali** — beda dari AR (`warranty_replacement` di AR itu WAJIB nunjuk credit note yang udah dibuat duluan, jadi tambahan DI ATAS retur; kalau AP niru pola itu tanpa penyeimbang, supplier jadi ngasih 2 kompensasi sekaligus — kurangi utang DAN kirim barang pengganti tanpa nagih balik — buat 1 kejadian rusak yang sama, gak masuk akal secara bisnis. AR sendiri sempat kena bug ini, sekarang sudah diperbaiki lewat pembalikan diskon proporsional di `warranty_replacement`, migration `0037`).
  - **Berlaku sama persis di semua status bayar** — Utang Usaha **gak pernah kesentuh**, mau bill-nya lunas, sebagian, atau belum dibayar sama sekali.
  - Jurnal: Debit Persediaan Bahan Baku (barang baru masuk) / Kredit Persediaan Bahan Baku (barang rusak keluar) — **net nol**, murni reklasifikasi fisik (barang keluar-masuk dicatat biar jejak audit per-kejadian lengkap), **tanpa** baris Beban — karena Barokah gak kehilangan nilai apa pun (dapat gantinya senilai sama).
  - **Beda dari barang rusak yang GAK dapat kompensasi sama sekali** (supplier nolak ganti maupun kurangi utang) — itu bukan retur, itu kerugian murni yang ditanggung Barokah sendiri (Beban Kerugian Barang Rusak), kasus terpisah di luar scope fitur ini (lihat "Belum Termasuk").

**Catatan implementasi sementara**: fitur ini baru nanganin item dengan metode costing **Weighted Average** — item FIFO diabaikan dulu karena FIFO rencananya mau dihapus dari sistem (lihat "Belum Termasuk"). Nilai barang yang diretur/ditukar dihitung dari harga rata-rata (`avg_cost`) **saat retur terjadi**, bukan harga asal pas barang diterima — konsisten dengan cara Weighted Average bekerja di modul Inventory (gak nyimpen asal-usul per batch).

## Constraint Wajib

**1. Bill & Payment tetap masuk General Ledger lewat jalur yang sama**
Gak ada jalur pencatatan utang yang bypass `journal_entries`/`journal_lines`. Tiap bill/payment wajib punya `journal_entry_id` yang dibuat via RPC yang manggil `create_journal_entry`, bukan insert manual.

**2. Immutability sama kayak Journal Entry & AR**
Bill/payment/allocation gak boleh diedit/dihapus. Koreksi = reversing entry.

**3. Total alokasi gak boleh lebih dari amount payment maupun amount bill**
Sama constraint anti over-allocation di AR — gak bisa alokasiin uang yang gak ada, gak bisa "kelunasan" ngelebihin utang yang emang ada.

**4. `due_date` dihitung sekali pas insert, snapshot dari `payment_term_days` supplier**
Perubahan termin supplier ke depan gak boleh retroaktif ngubah `due_date` bill lama.

**5. Bill salah input cuma boleh dibatalkan kalau BELUM ada payment/alokasi masuk**
Sama guard yang dipakai di AR (`cancel_ar_invoice`) — begitu ada 1 alokasi aja, pembatalan ditolak. Beda dari AR, di AP aturan ini **langsung diterapkan dari awal** (bukan ditambah belakangan), karena udah kebukti perlu dari pengalaman desain AR.

**6. No over-return — gabungan Opsi A + Opsi B**
Total qty yang diklaim retur (Opsi A) **plus** total qty yang ditukar (Opsi B) buat 1 item di 1 bill yang sama, gak boleh ngelebihin qty yang beneran diterima di bill itu. Ini guard baru (gabungan 2 mekanisme sekaligus, bukan cuma 1) — beda dari item FIFO yang otomatis kejaga lewat batas per-lot, item Weighted Average butuh pengecekan eksplisit karena stoknya udah nyampur, gak ada cara nelusurin balik "qty ini asalnya dari bill mana".

**7. No over-use Piutang Retur Supplier**
Total saldo yang dipakai motong bill lain plus yang dicairkan tunai, gak boleh ngelebihin nominal awal saldo itu — pola sama guard di AR (`ar_customer_credits`).

## Skenario (lihat detail angka lengkap di `docs/story/accounts-payable.md`)

1. Bill lunas tepat waktu — pola identik AR skenario 1.
2. Bayar sebagian (cicil) — pola identik AR skenario 2.
3. Bayar gabungan ke 1 supplier — beberapa bill kecil dinutup 1 payment, pola identik AR skenario 3.
4. Telat bayar — **beda arah dari AR**. Di AR, yang nanggung resiko telat itu kita (piutang macet, harus nagih). Di AP, kalau **CV Barokah** yang telat bayar, resikonya: supplier bisa setop kirim bahan baku berikutnya. Aging query (`due_date < now()` belum lunas) tetap sama, tapi maknanya "bill mana yang HARUS kita bayar duluan", bukan "piutang mana yang harus ditagih".
5. Bill dibatalkan (salah input, belum ada payment) — reversing entry via RPC `cancel_ap_bill`, sama pola AR skenario 5.
6. Retur (Opsi A — kurangi utang), bill belum lunas — utang beneran berkurang, lihat "Retur Barang ke Supplier".
7. Retur (Opsi A), bill udah lunas — outstanding jadi minus, otomatis jadi Piutang Retur Supplier.
8. Retur (Opsi B — tukar barang) — berdiri sendiri, Utang Usaha gak kesentuh, independen dari status bayar.
9. Piutang Retur Supplier dipakai motong bill lain, atau dicairkan tunai.

## Common Mistakes

- Sama semua common mistake di AR (`accounts-receivable.md`), cuma arah kebalik: due_date dihitung ulang dinamis (harusnya snapshot), status disimpan manual (harusnya derived), payment langsung bill_id tanpa tabel alokasi, insert AP tanpa lewat RPC yang juga bikin journal entry, alokasi ngelebihin amount, batalin bill yang udah ada alokasi tanpa guard.
- **Khusus AP**: salah pilih akun debit pas bikin bill — bahan baku (Persediaan, asset) vs jasa/sewa/utility (Beban, expense langsung). RPC `create_ap_bill` terima akun debit sebagai parameter (gak di-hardcode), jadi kesalahan pilih akun itu tanggung jawab yang input, bukan dicegah sistem — sama pola `create_ar_invoice`/`create_journal_entry` yang emang generik.
- **Retur**: Opsi A dan Opsi B dianggap bisa jalan bareng buat 1 kejadian retur yang sama — itu kompensasi ganda dari sisi supplier, cuma boleh pilih salah satu.
- **Retur**: excess dari Opsi A (bill udah lunas) dianggap otomatis berarti barang harus diganti (Opsi B) — dua-duanya independen, resolusi yang dipilih adalah keputusan bisnis, bukan konsekuensi status bayar.
- **Retur**: barang rusak yang gak dapat kompensasi sama sekali (supplier nolak) dicatat lewat jalur retur — itu kasus terpisah (kerugian/write-off), lihat "Belum Termasuk".

## Belum Termasuk (di luar scope fase ini)

Detail lengkap tiap item ada di `memory/scope-debt/`:

- **Diskon bayar cepat (early payment discount)** — `memory/scope-debt/ap-diskon-bayar-cepat.md`. Ini kasus yang gak ada padanannya di AR — supplier sering kasih termin kayak "2/10, net 30".
- **Uang muka/DP ke supplier** — `memory/scope-debt/ap-uang-muka-dp.md`.
- **Bill kepisah kategori (compound debit)** — `memory/scope-debt/ap-bill-compound.md`. Nota supplier yang isinya campuran (misal barang + ongkos kirim) butuh RPC yang nerima array baris debit, bukan 1 akun tetap.
- **Kerugian barang rusak tanpa kompensasi supplier** — `memory/scope-debt/kerugian-barang-rusak.md`. Lintas modul AR & AP — barang rusak yang gak diganti maupun gak dikurangin utangnya (atau di AR, gak dikurangin piutangnya) harus diakui sebagai kerugian (Beban Kerugian Barang Rusak), bukan lewat jalur retur.
- **Retur/tukar barang untuk item FIFO** — fitur ini baru nanganin item Weighted Average. FIFO rencananya mau dihapus dari sistem, lihat `memory/scope-debt/penghapusan-fifo.md`.
