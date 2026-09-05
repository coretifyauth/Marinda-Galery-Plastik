# Accounts Receivable — Struktur Data & Teknis

Fase 3. Konsep bisnisnya ada di `docs/domain/accounts-receivable.md`. Detail teknis penuh (DDL/trigger): `memory/architecture/data/ar-schema.md` + `memory/architecture/data/transactions-schema.md` (tabel inti, digabung dengan Accounts Payable sejak 2026-09-05).

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `counterparties` | Master data pelanggan (nama, kontak, termin pembayaran) | — |
| `transactions` (baris `type='INBOUND'`) | Tagihan yang diterbitkan ke pelanggan — tabel yang sama juga dipakai Accounts Payable (baris `type='OUTBOUND'`, lihat `docs/architecture/ap-schema.md`) | `counterparties`, dan ke transaksi jurnal yang otomatis dibuat |
| `payments` (baris `type='INBOUND'`) | Pembayaran yang diterima dari pelanggan — selalu menunjuk 1 invoice spesifik, boleh cicil, gak boleh kelebihan bayar — tabel yang sama juga dipakai Accounts Payable (baris `type='OUTBOUND'`) | `counterparties`, `transactions` (banyak-ke-satu), dan ke transaksi jurnal yang otomatis dibuat |
| `credit_notes` (baris `type='INBOUND'`) | Retur barang — kejadian nyata barang balik, bukan koreksi salah input — tabel yang sama juga dipakai Accounts Payable (baris `type='OUTBOUND'`) | `transactions` (1 invoice bisa punya banyak retur), dan ke transaksi jurnal kontra-revenue yang otomatis dibuat |
| `inventory_returns` + `inventory_return_lines` | Sisi stok/HPP retur — cuma ada kalau invoicenya lahir dari Goods Issue | `credit_notes` (1 pasangan tiap retur fisik), `goods_issues`, dan ke transaksi jurnal reversal HPP |
| `ar_return_credits` | Saldo kredit yang lahir otomatis dari retur yang terjadi setelah invoice lunas — bagian dari alur Retur Barang | `counterparties`, `credit_notes` (sumbernya), dan ke transaksi jurnal reklasifikasi |
| `ar_return_credit_refunds` | Saldo kredit retur dikembalikan tunai ke pelanggan | `ar_return_credits`, dan ke transaksi jurnal |
| `warranty_replacements` + `warranty_replacement_lines` | Penukaran barang pasca-retur/garansi — independen dari retur, gak nyentuh Piutang Usaha sama sekali | `transactions` langsung, dan ke 1 transaksi jurnal (HPP/Persediaan) |
| `deposits` (baris `type='INBOUND'`) | Uang muka/DP diterima sebelum invoice ada — tabel yang sama juga dipakai Accounts Payable (baris `type='OUTBOUND'`) | `counterparties`, dan ke transaksi jurnal (Kas → Uang Muka Penjualan) |
| `deposit_applications` | DP diterapkan ke invoice yang udah diterbitkan — tabel yang sama juga dipakai Accounts Payable | Menghubungkan `deposits` ↔ `transactions`, dan ke transaksi jurnal reklasifikasi |
| `deposit_refunds` | DP dicairkan tunai kembali — tidak berdampak Laba Rugi — tabel yang sama juga dipakai Accounts Payable | `deposits`, dan ke transaksi jurnal |
| `deposit_forfeitures` | DP dianggap hangus, partial-capable — tabel yang sama juga dipakai Accounts Payable | `deposits`, dan ke transaksi jurnal |
| `ar_invoice_charge_types` | Katalog kategori pendapatan tambahan yang bisa dipilih staf saat bikin invoice — murni master data, disiapkan admin | `accounts` (akun tujuan tiap kategori) |
| `tax_settings` | Pengaturan PPN (tarif, status aktif, akun Keluaran/Masukan) — 1 baris untuk seluruh sistem, dipakai bareng AP/AR/POS | `accounts` (akun PPN Keluaran/Masukan) |

**Catatan (2026-09-05)**: `ar_invoices` (tabel invoice AR) dan `ar_invoice_credit_lines` (rincian baris kredit) sudah digabung ke tabel generic `transactions`/`transaction_lines` yang dipakai bareng Accounts Payable — lihat `docs/architecture/ap-schema.md`. Fitur **Credit Hold** (batas kredit customer) dan **Piutang Tak Tertagih** (write-off) yang dulu ada di modul ini sudah **dicabut total** (keputusan owner) — customer gak lagi punya batas kredit yang ditegakkan sistem, dan AR gak lagi punya jalur formal nyatet piutang macet jadi beban. `ar_payments` juga sudah digabung ke tabel generic `payments` (dipakai bareng Accounts Payable) — RPC `record_ar_payment` diganti `record_payment`. `ar_credit_notes` juga sudah digabung ke tabel generic `credit_notes` (dipakai bareng Accounts Payable) — RPC `create_ar_credit_note` TETAP ADA (gak digabung jadi 1 RPC, logic-nya beneran beda bentuk dari sisi AP), cuma tabel penyimpanannya yang digabung. `ar_deposits`+turunannya (applications/refunds/forfeitures) juga sudah digabung ke tabel generic `deposits`/`deposit_applications`/`deposit_refunds`/`deposit_forfeitures` (dipakai bareng Accounts Payable) — RPC `create_ar_deposit`/`apply_ar_deposit`/`refund_ar_deposit`/`forfeit_ar_deposit` diganti `create_deposit`/`apply_deposit`/`refund_deposit`/`forfeit_deposit`.

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `counterparties` | Master data pelanggan | — |
| `transactions` (`type='INBOUND'`) | Piutang timbul — tabel generic yang sama juga dipakai Accounts Payable | `counterparties`, transaksi jurnal |
| `payments` (`type='INBOUND'`) | Piutang berkurang — tabel generic yang sama juga dipakai Accounts Payable | `counterparties`, `transactions`, transaksi jurnal |

**Struktur invoice (baris `transactions` tipe `INBOUND`)**

| Kolom | Isinya | Catatan |
|---|---|---|
| pelanggan | Siapa yang berutang | |
| tanggal invoice, jatuh tempo | Kapan diterbitkan, kapan harus lunas | Jatuh tempo dihitung sekali dari termin pelanggan **saat invoice dibuat**, lalu disimpan permanen — kalau termin pelanggan berubah belakangan, invoice lama tidak ikut berubah |
| jumlah | Nilai tagihan | |
| status (lunas/sebagian/belum/dibatalkan), sisa tagihan, tipe asal | — | Kolom tersimpan, tapi **gak bisa diedit manual** — otomatis di-update sistem tiap ada pembayaran/DP/retur baru yang nyentuh invoice ini |

Kenapa cukup satu pembayaran nunjuk satu invoice (bukan tabel jembatan banyak-ke-banyak) — kebijakan penagihan tetap gak izinin **bayar gabungan** maupun **kelebihan bayar**. Tapi **cicilan boleh** — 1 invoice bisa punya banyak baris pembayaran dari waktu ke waktu, `payments.transaction_id` gak unik.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat invoice | `create_transaction` (`p_type='INBOUND'`) | Menghitung `due_date`, memanggil `create_journal_entry` (Debit Piutang Usaha, Kredit Pendapatan), insert `transactions` menunjuk `journal_entry_id` | Minimal 1 baris kategori, tiap baris nominal > 0 |
| Catat pembayaran | `record_payment` (`p_type='INBOUND'`) | Memanggil `create_journal_entry` (Debit Kas/Bank, Kredit Piutang Usaha), insert `payments` menunjuk 1 `transaction_id` | `p_amount > ar_invoice_remaining(transaction_id)` → `raise exception` (overpay ditolak, cicil lolos) |
| Batalkan invoice | `cancel_ar_invoice` | Memanggil `reverse_journal_entry` pakai akun sama persis; invoice asli tidak diedit | Ditolak kalau ada `payments` (`type='INBOUND'`); auto-unwind `deposit_applications` aktif |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Pembayaran boleh kurang dari sisa tagihan, gak boleh lebih | `record_payment` — cek `p_amount > ar_invoice_remaining(transaction_id)` |
| Data invoice asli (pelanggan/tanggal/jumlah) gak boleh diedit/dihapus | RLS tanpa policy `update`/`delete` + trigger selektif — cuma kolom status/sisa tagihan yang boleh berubah, sisanya tetap terkunci total |
| Invoice cuma bisa dibatalkan kalau belum ada pembayaran | `cancel_ar_invoice` — `count(*) from payments where transaction_id = ... and type='INBOUND'` > 0 → `raise exception` |
| `due_date` snapshot, gak retroaktif ikut perubahan termin | `create_transaction` — dihitung sekali dari `counterparties.payment_term_days` saat insert, disimpan sebagai kolom biasa |
| Status invoice gak bisa nyimpang dari kenyataan pembayaran | Diupdate otomatis sistem tiap ada baris baru di pembayaran/DP/retur — bukan dientri manual, dan gak bisa ketinggalan karena nempel di titik transaksi terjadi, bukan dihitung belakangan |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `transactions` (`INBOUND`) | banyak-ke-satu | `counterparties` |
| `payments` (`INBOUND`) | banyak-ke-satu | `transactions` |
| `transactions` / `payments` | satu-ke-satu (`journal_entry_id`, `not null`) | `journal_entries` |

## Retur Barang (Credit Note)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `credit_notes` (`type='INBOUND'`) | Retur barang — kejadian nyata barang balik — tabel generic yang sama juga dipakai Accounts Payable | `transactions` (banyak retur per invoice), dan ke transaksi jurnal kontra-revenue yang otomatis dibuat |
| `inventory_returns` + `inventory_return_lines` | Sisi stok/HPP retur — cuma ada kalau invoicenya lahir dari Goods Issue | `credit_notes` (1 pasangan tiap retur fisik), `goods_issues`, dan ke transaksi jurnal reversal HPP |
| `ar_return_credits` | Saldo kredit yang lahir otomatis kalau retur bikin invoice yang sudah lunas jadi minus | `counterparties`, `credit_notes` (sumbernya), dan ke transaksi jurnal reklasifikasi |
| `ar_return_credit_refunds` | Saldo kredit retur di atas dicairkan tunai — satu-satunya cara aktif nyelesaiin saldo itu ke depan (jalur "settle via barang" cuma berlaku data historis, lihat submodule "Penukaran Barang Pasca-Retur") | `ar_return_credits`, dan ke transaksi jurnal |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat retur | `create_ar_credit_note` | Deteksi otomatis financial-only vs full (cek `goods_issues` terkait invoice); insert `credit_notes` + jurnal kontra-revenue (Debit Retur & Potongan Penjualan, Kredit Piutang Usaha); kalau full, insert `inventory_return_lines` per baris (tiap baris punya `condition` — baris Layak Jual masuk lagi ke `inventory_balances`, baris Rusak TIDAK, cost-nya jadi Debit Beban Kerugian Barang Rusak) + jurnal reversal HPP | Trigger `credit_notes_no_over_return` (total retur ≤ nilai invoice); trigger `inventory_return_lines_guard` (qty retur ≤ `goods_issue_lines.qty_issued`, jalur full) |
| Deteksi & cairkan excess jadi saldo kredit | `create_ar_credit_note` (lanjutan aksi di atas, 1 pemanggilan) | Hitung `v_remaining_before := ar_invoice_remaining(invoice_id)` sebelum retur masuk; `v_excess := greatest(0, amount − greatest(0, v_remaining_before))`; kalau `> 0`, jurnal tambahan Debit Piutang Usaha / Kredit Saldo Kredit Retur Customer + insert `ar_return_credits` | Param akun liability wajib diisi kalau ada excess |
| Refund tunai saldo kredit retur | `refund_ar_return_credit` | Jurnal Debit Saldo Kredit Retur Customer, Kredit Kas/Bank; insert `ar_return_credit_refunds` | `amount > ar_return_credit_remaining(credit_id)` → tolak |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Retur gak boleh melebihi nilai/qty invoice | Trigger `credit_notes_no_over_return` + `inventory_return_lines_guard` |
| Retur boleh dibuat walau invoice sudah lunas | `create_ar_credit_note` tidak cek status lunas (beda dari `cancel_ar_invoice`) |
| Retur gak boleh masuk periode tertutup | Trigger block-retroactive-period (reuse dari `create_journal_entry`, sama seperti seluruh modul GL) |
| Reversal HPP pakai harga snapshot, bukan harga sekarang | `inventory_return_lines.total_cost` dihitung dari `goods_issue_lines.total_cost` asli, bukan dihitung ulang |
| Excess retur (bikin outstanding negatif) otomatis jadi saldo kredit resmi, bukan cuma angka minus | `create_ar_credit_note` — `v_excess` dihitung dari bagian yang melebihi `v_remaining_before`, bukan seluruh nominal retur |
| Saldo kredit retur cuma bisa refund tunai, gak bisa dipakai motong invoice lain | RPC `refund_ar_return_credit` — satu-satunya jalur aktif ke depan (jalur "settle via ganti barang" cuma peninggalan data lama, `create_warranty_replacement` sekarang gak pernah nyentuh `ar_return_credits` lagi) |
| Total yang dicairkan dari saldo kredit retur ≤ sisa saldo | Fungsi `ar_return_credit_remaining(credit_id) = amount − SUM(warranty_replacements.return_credit_settled_amount, histori doang) − SUM(refunds)` |
| Gak ada batas waktu retur (umur invoice vs tanggal retur) | Sengaja dicabut total — validasi ini sempat ada (per item & per customer), sekarang murni keputusan manual staf di luar sistem |
| Barang Rusak gak boleh balik jadi stok bernilai — kompensasi ke customer tetap jalan, cost-nya jadi kerugian | Kolom `inventory_return_lines.condition` — baris `DAMAGED` skip update `inventory_balances`, cost masuk Debit Beban Kerugian Barang Rusak; kontra-revenue tidak terpengaruh `condition` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `credit_notes` | banyak-ke-satu | `transactions` |
| `inventory_returns` | satu-ke-satu per retur fisik | `credit_notes` |
| `inventory_returns` | banyak-ke-satu | `goods_issues` |
| `inventory_return_lines.total_cost` | snapshot dari | `goods_issue_lines.total_cost` |
| `ar_return_credits` | satu-ke-satu | `credit_notes` (sumbernya) |
| `ar_return_credits` | banyak-ke-satu | `counterparties` |
| `ar_return_credit_refunds` | banyak-ke-satu | `ar_return_credits` |
| `warranty_replacements.return_credit_settled_amount` (submodule lain, HISTORIS doang) | akumulasi terhadap | `ar_return_credits` (via `credit_notes.credit_note_id`, baris lama) |

## Penukaran Barang Pasca-Retur (Garansi)

**Restrukturisasi (2026-09-03, keputusan owner)**: dulu wajib menunjuk retur (`credit_notes`) yang sudah ada, lalu membalikkan sebagian diskon retur biar gak dobel kompensasi. Sekarang independen — langsung menunjuk invoice, gak pernah nyentuh retur/Piutang Usaha sama sekali. 1 unit barang yang sama cuma bisa diklaim SATU jalur (retur ATAU ganti barang), dicegah dari awal lewat fungsi gabungan yang dicek dari kedua arah — bukan lagi "izinkan dua jalur lalu koreksi belakangan".

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `warranty_replacements` + `warranty_replacement_lines` | Penukaran barang pasca-retur/garansi — bukan gratis, tanpa invoice baru, gak nyentuh Piutang Usaha sama sekali | `transactions` langsung, dan ke 1 transaksi jurnal (HPP/Persediaan Barang Jadi) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat penukaran | `create_warranty_replacement` | 1 jurnal: Debit HPP, Kredit Persediaan Barang Jadi, ambil stok dari `inventory_balances` | Qty diganti (akumulasi per item per invoice) ≤ qty terjual dikurangi total yang udah diklaim lintas SEMUA jalur (retur-kredit + ganti-barang sebelumnya) |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| 1 unit barang yang terjual cuma bisa diklaim SATU jalur — retur (dapat kredit/diskon) ATAU ganti barang, gak bisa dua-duanya | Fungsi gabungan "qty sudah diklaim" (jumlah retur + ganti-barang), dicek di KEDUA arah — mau retur maupun mau ganti barang, keduanya baca angka yang sama, jadi urutan mana pun duluan tetap konsisten dicegah |
| Invoice financial-only (gak ada barang fisik terjual) gak bisa jadi dasar ganti barang | Invoice wajib punya pengeluaran barang (Goods Issue) sebelum bisa diajukan ganti barang |
| Barang pengganti dari stok aktif, bukan barang bekas retur yang rusak | Konsumsi via `inventory_balances` (Weighted Average) — segregasi dijaga logis lewat `condition` di AR Credit Note (baris Rusak gak pernah masuk pool ini) |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `warranty_replacements` | wajib FK | `transactions` |
| `warranty_replacements` | opsional, cuma keisi di data historis (sebelum restrukturisasi) | `credit_notes` |

**Catatan histori**: kolom-kolom lama (pembalikan diskon, penyelesaian saldo kredit retur) masih ada di tabel buat data sebelum restrukturisasi — transaksi baru gak pernah mengisinya lagi.

## Uang Muka / DP (Deposit)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `deposits` | Uang muka/DP diterima sebelum invoice ada | `counterparties`, dan ke transaksi jurnal (Kas → Uang Muka Penjualan) yang otomatis dibuat |
| `deposit_applications` | DP diterapkan ke invoice yang udah diterbitkan | Menghubungkan `deposits` ↔ `transactions`, dan ke transaksi jurnal reklasifikasi |
| `deposit_refunds` | DP dicairkan tunai kembali ke pelanggan — tidak berdampak Laba Rugi | `deposits`, dan ke transaksi jurnal (Uang Muka Penjualan → Kas) |
| `deposit_forfeitures` | DP dianggap hangus, partial-capable | `deposits`, dan ke transaksi jurnal (Uang Muka Penjualan → Pendapatan Lain-lain) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Terima DP | `create_deposit` | Jurnal Debit Kas/Bank, Kredit Uang Muka Penjualan; insert `deposits` | — |
| Terapkan ke invoice | `apply_deposit` | Jurnal Debit Uang Muka Penjualan, Kredit Piutang Usaha; insert `deposit_applications` | Trigger `deposit_applications_guard` — `amount > deposit_remaining(deposit_id)` → tolak; invoice target harus customer sama & belum dibatalkan |
| Refund tunai | `refund_deposit` | Jurnal Debit Uang Muka Penjualan, Kredit Kas/Bank; insert `deposit_refunds` | Trigger `deposit_refunds_guard` — `amount > deposit_remaining(deposit_id)` → tolak |
| Hanguskan | `forfeit_deposit` | Jurnal Debit Uang Muka Penjualan, Kredit Pendapatan Lain-lain; insert `deposit_forfeitures` | Trigger `deposit_forfeitures_guard` — `amount > deposit_remaining(deposit_id)` → tolak |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| DP gak boleh langsung diakui Pendapatan/pengurang Piutang saat diterima | `create_deposit` — jurnal selalu ke akun Uang Muka Penjualan (liability), bukan Piutang/Pendapatan |
| Total penyelesaian DP (diterapkan + refund + hangus) ≤ nilai DP awal | Fungsi terpusat `deposit_remaining(deposit_id) = amount − SUM(applications) − SUM(refunds) − SUM(forfeitures)`, dipakai ketiga trigger guard |
| Invoice yang DP-nya diterapkan dibatalkan → penerapan DP ikut dibalik | `cancel_ar_invoice` — loop `deposit_applications` aktif milik invoice itu, panggil `reverse_journal_entry` per baris |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `deposits` | banyak-ke-satu | `counterparties` |
| `deposit_applications` | menghubungkan | `deposits` ↔ `transactions` |
| `deposit_refunds` / `deposit_forfeitures` | banyak-ke-satu | `deposits` |

## Kategori Campur & PPN

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `transaction_lines` | Rincian baris kredit (kategori pendapatan + PPN) 1 invoice — tabel generic yang sama juga dipakai Accounts Payable | `transactions` (banyak-ke-satu) |
| `ar_invoice_charge_types` | Katalog kategori pendapatan tambahan, dipetakan ke akun tetap — master data, bukan tabel transaksional | `accounts` |
| `tax_settings` | Pengaturan PPN — 1 baris untuk seluruh sistem (tarif, status aktif, akun Keluaran/Masukan), dipakai bareng AP/POS | `accounts` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Bikin invoice dengan >1 kategori pendapatan | `create_transaction` (`p_lines` array) | 1 baris jurnal kredit per kategori, insert `transaction_lines` per baris | Minimal 1 baris kategori, tiap baris nominal > 0 |
| Bikin invoice dengan PPN | `create_transaction` (`p_apply_tax=true`) | Tambahan 1 baris kredit PPN Keluaran, dihitung dari `tax_settings.ppn_rate` | Ditolak kalau `tax_settings.is_active=false` atau akun PPN Keluaran belum diset |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Kategori tambahan dipilih dari katalog, bukan akun bebas | Diselesaikan di UI (dropdown `ar_invoice_charge_types`) — RPC sendiri tetap menerima `account_id` mentah, sama seperti akun Piutang/Pendapatan yang sudah ada |
| PPN gak boleh diketik manual | `create_transaction` menghitung sendiri nominal PPN dari `tax_settings`, bukan menerima dari parameter klien |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `transaction_lines` | banyak-ke-satu | `transactions` |
| `ar_invoice_charge_types` | referensi (dipakai UI, bukan FK langsung) | `transaction_lines` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pelanggan, invoice, pembayaran, uang muka | Semua user yang sudah login |
| Menambah pelanggan baru, mengubah data pelanggan | Role `admin` atau `accountant` |
| Membuat invoice, mencatat pembayaran, mencatat/menerapkan/menghanguskan uang muka, refund saldo kredit retur, mencatat penukaran barang | Role `admin` atau `accountant` |
| Mengedit atau menghapus invoice/pembayaran/retur/uang muka | **Tidak ada seorang pun** — hanya pembatalan/retur lewat jalur resmi yang diizinkan |
| Menghapus data pelanggan secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan |
| Menambah/menonaktifkan kategori pendapatan tambahan, mengubah Pengaturan Pajak | Role `admin` |
