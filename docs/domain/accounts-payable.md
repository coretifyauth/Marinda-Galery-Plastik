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

## Skenario (lihat detail angka lengkap di `docs/story/accounts-payable.md`)

1. Bill lunas tepat waktu — pola identik AR skenario 1.
2. Bayar sebagian (cicil) — pola identik AR skenario 2.
3. Bayar gabungan ke 1 supplier — beberapa bill kecil dinutup 1 payment, pola identik AR skenario 3.
4. Telat bayar — **beda arah dari AR**. Di AR, yang nanggung resiko telat itu kita (piutang macet, harus nagih). Di AP, kalau **CV Barokah** yang telat bayar, resikonya: supplier bisa setop kirim bahan baku berikutnya. Aging query (`due_date < now()` belum lunas) tetap sama, tapi maknanya "bill mana yang HARUS kita bayar duluan", bukan "piutang mana yang harus ditagih".
5. Bill dibatalkan (salah input, belum ada payment) — reversing entry via RPC `cancel_ap_bill`, sama pola AR skenario 5.

## Common Mistakes

- Sama semua common mistake di AR (`accounts-receivable.md`), cuma arah kebalik: due_date dihitung ulang dinamis (harusnya snapshot), status disimpan manual (harusnya derived), payment langsung bill_id tanpa tabel alokasi, insert AP tanpa lewat RPC yang juga bikin journal entry, alokasi ngelebihin amount, batalin bill yang udah ada alokasi tanpa guard.
- **Khusus AP**: salah pilih akun debit pas bikin bill — bahan baku (Persediaan, asset) vs jasa/sewa/utility (Beban, expense langsung). RPC `create_ap_bill` terima akun debit sebagai parameter (gak di-hardcode), jadi kesalahan pilih akun itu tanggung jawab yang input, bukan dicegah sistem — sama pola `create_ar_invoice`/`create_journal_entry` yang emang generik.

## Belum Termasuk (di luar scope fase ini)

Detail lengkap tiap item ada di `memory/scope-debt/`:

- **Retur barang ke supplier** — `memory/scope-debt/ap-retur-barang.md`.
- **Diskon bayar cepat (early payment discount)** — `memory/scope-debt/ap-diskon-bayar-cepat.md`. Ini kasus yang gak ada padanannya di AR — supplier sering kasih termin kayak "2/10, net 30".
- **Uang muka/DP ke supplier** — `memory/scope-debt/ap-uang-muka-dp.md`.
- **Bill kepisah kategori (compound debit)** — `memory/scope-debt/ap-bill-compound.md`. Nota supplier yang isinya campuran (misal barang + ongkos kirim) butuh RPC yang nerima array baris debit, bukan 1 akun tetap.
