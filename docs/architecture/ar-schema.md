# Accounts Receivable — Struktur Data & Teknis

Fase 3. Konsep bisnisnya ada di `docs/domain/accounts-receivable.md`. Detail teknis penuh (DDL/trigger): `memory/architecture/data/ar-schema.md`.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `customers` | Master data pelanggan (nama, kontak, termin pembayaran, batas kredit, toleransi telat) | — |
| `ar_invoices` | Tagihan yang diterbitkan ke pelanggan | `customers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ar_payments` | Pembayaran yang diterima dari pelanggan — selalu menunjuk 1 invoice spesifik, boleh cicil, gak boleh kelebihan bayar | `customers`, `ar_invoices` (banyak-ke-satu), dan ke transaksi jurnal yang otomatis dibuat |
| `ar_credit_notes` | Retur barang — kejadian nyata barang balik, bukan koreksi salah input | `ar_invoices` (1 invoice bisa punya banyak retur), dan ke transaksi jurnal kontra-revenue yang otomatis dibuat |
| `inventory_returns` + `inventory_return_lines` | Sisi stok/HPP retur — cuma ada kalau invoicenya lahir dari Goods Issue | `ar_credit_notes` (1 pasangan tiap retur fisik), `goods_issues`, dan ke transaksi jurnal reversal HPP |
| `ar_return_credits` | Saldo kredit yang lahir otomatis dari retur yang terjadi setelah invoice lunas — bagian dari alur Retur Barang | `customers`, `ar_credit_notes` (sumbernya), dan ke transaksi jurnal reklasifikasi |
| `ar_return_credit_refunds` | Saldo kredit retur dikembalikan tunai ke pelanggan | `ar_return_credits`, dan ke transaksi jurnal |
| `warranty_replacements` + `warranty_replacement_lines` | Penukaran barang pasca-retur/garansi — wajib membalikkan diskon retur proporsional, opsional menyelesaikan saldo kredit retur | `ar_credit_notes` (wajib retur fisik dulu), `ar_return_credits` (via `ar_credit_notes`, kalau ada), sampai 3 transaksi jurnal |
| `ar_deposits` | Uang muka/DP diterima sebelum invoice ada | `customers`, dan ke transaksi jurnal (Kas → Uang Muka Penjualan) |
| `ar_deposit_applications` | DP diterapkan ke invoice yang udah diterbitkan | Menghubungkan `ar_deposits` ↔ `ar_invoices`, dan ke transaksi jurnal reklasifikasi |
| `ar_deposit_refunds` | DP dicairkan tunai kembali — tidak berdampak Laba Rugi | `ar_deposits`, dan ke transaksi jurnal |
| `ar_deposit_forfeitures` | DP dianggap hangus, partial-capable | `ar_deposits`, dan ke transaksi jurnal |
| `ar_bad_debt_writeoffs` | Piutang yang benar-benar tidak akan tertagih, dihapusbukukan | `ar_invoices` (1 invoice bisa punya lebih dari satu write-off parsial), dan ke transaksi jurnal |
| `ar_invoice_credit_lines` | Rincian baris kredit (kategori pendapatan + PPN) 1 invoice, kalau lebih dari 1 kategori | `ar_invoices` (banyak-ke-satu) |
| `ar_invoice_charge_types` | Katalog kategori pendapatan tambahan yang bisa dipilih staf saat bikin invoice — murni master data, disiapkan admin | `accounts` (akun tujuan tiap kategori) |
| `tax_settings` | Pengaturan PPN (tarif, status aktif, akun Keluaran/Masukan) — 1 baris untuk seluruh sistem, dipakai bareng AP/AR/POS | `accounts` (akun PPN Keluaran/Masukan) |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `customers` | Master data pelanggan | — |
| `ar_invoices` | Piutang timbul | `customers`, transaksi jurnal |
| `ar_payments` | Piutang berkurang | `customers`, `ar_invoices`, transaksi jurnal |

**Struktur `ar_invoices`**

| Kolom | Isinya | Catatan |
|---|---|---|
| pelanggan | Siapa yang berutang | |
| tanggal invoice, jatuh tempo | Kapan diterbitkan, kapan harus lunas | Jatuh tempo dihitung sekali dari termin pelanggan **saat invoice dibuat**, lalu disimpan permanen — kalau termin pelanggan berubah belakangan, invoice lama tidak ikut berubah |
| jumlah | Nilai tagihan | |
| status (lunas/belum/dibatalkan) | — | **Tidak disimpan**, selalu dihitung ulang dari ada-tidaknya pembayaran yang tercatat buat invoice ini dibanding nilai invoice |

Kenapa cukup satu pembayaran nunjuk satu invoice (bukan tabel jembatan banyak-ke-banyak) — kebijakan penagihan tetap gak izinin **bayar gabungan** maupun **kelebihan bayar**. Tapi **cicilan boleh** — 1 invoice bisa punya banyak baris pembayaran dari waktu ke waktu, `ar_payments.invoice_id` gak unik.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat invoice | `create_ar_invoice` | Menghitung `due_date`, memanggil `create_journal_entry` (Debit Piutang Usaha, Kredit Pendapatan), insert `ar_invoices` menunjuk `journal_entry_id` | Lihat submodule "Credit Hold" |
| Catat pembayaran | `record_ar_payment` | Memanggil `create_journal_entry` (Debit Kas/Bank, Kredit Piutang Usaha), insert `ar_payments` menunjuk 1 `invoice_id` | `p_amount > ar_invoice_remaining(invoice_id)` → `raise exception` (overpay ditolak, cicil lolos) |
| Batalkan invoice | `cancel_ar_invoice` | Memanggil `reverse_journal_entry` pakai akun sama persis; invoice asli tidak diedit | Ditolak kalau ada `ar_payments` atau `ar_bad_debt_writeoffs`; auto-unwind `ar_deposit_applications` aktif |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Pembayaran boleh kurang dari sisa tagihan, gak boleh lebih | `record_ar_payment` — cek `p_amount > ar_invoice_remaining(invoice_id)` |
| Invoice/payment gak boleh diedit/dihapus | RLS tanpa policy `update`/`delete` + trigger `block_edit_delete` (reuse dari Journal Entry) |
| Invoice cuma bisa dibatalkan kalau belum ada pembayaran | `cancel_ar_invoice` — `count(*) from ar_payments where invoice_id = ...` > 0 → `raise exception` |
| `due_date` snapshot, gak retroaktif ikut perubahan termin | `create_ar_invoice` — dihitung sekali dari `customers.payment_term_days` saat insert, disimpan sebagai kolom biasa |
| Status invoice derived, bukan kolom manual | Dihitung dari `SUM(ar_payments.amount)` vs `ar_invoices.amount`, ditambah cek reversal di `journal_entries` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `ar_invoices` | banyak-ke-satu | `customers` |
| `ar_payments` | banyak-ke-satu | `ar_invoices` |
| `ar_invoices` / `ar_payments` | satu-ke-satu (`journal_entry_id`, `not null`) | `journal_entries` |

## Credit Hold

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `customers` (kolom `credit_limit`, `overdue_threshold_days`) | Batas kredit & toleransi telat per customer, nullable = tidak ada batas | — |

Tidak ada tabel baru — hold dihitung dari kolom di `customers` + agregat outstanding `ar_invoices`, tidak ada kolom status hold yang disimpan.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Cek hold sebelum buat invoice | `create_ar_invoice` | Query `ar_invoice_remaining()` semua invoice open milik customer (prospektif, `outstanding + p_amount`) + cek overdue terlama vs `due_date` | `(outstanding + p_amount) > credit_limit` ATAU `max_overdue_days > overdue_threshold_days` → `raise exception` sebelum `create_journal_entry` dipanggil |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Invoice baru ditolak kalau customer kena credit hold | `create_ar_invoice` — cek nominal (prospektif) DAN waktu (OR), sebelum jurnal dibuat |
| `credit_limit`/`overdue_threshold_days` NULL = gak ada batas dari sisi itu | Kondisi di-skip di `create_ar_invoice` kalau kolom NULL |
| Status hold tidak boleh disimpan manual | Tidak ada kolom status — dihitung ulang tiap `create_ar_invoice` dipanggil |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `customers.credit_limit` / `overdue_threshold_days` | dibandingkan terhadap agregat `ar_invoice_remaining()` | `ar_invoices` (invoice open milik customer, exclude yang punya reversal) |

## Retur Barang (Credit Note)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `ar_credit_notes` | Retur barang — kejadian nyata barang balik | `ar_invoices` (banyak retur per invoice), dan ke transaksi jurnal kontra-revenue yang otomatis dibuat |
| `inventory_returns` + `inventory_return_lines` | Sisi stok/HPP retur — cuma ada kalau invoicenya lahir dari Goods Issue | `ar_credit_notes` (1 pasangan tiap retur fisik), `goods_issues`, dan ke transaksi jurnal reversal HPP |
| `ar_return_credits` | Saldo kredit yang lahir otomatis kalau retur bikin invoice yang sudah lunas jadi minus | `customers`, `ar_credit_notes` (sumbernya), dan ke transaksi jurnal reklasifikasi |
| `ar_return_credit_refunds` | Saldo kredit retur di atas dicairkan tunai — satu dari dua satu-satunya cara nyelesaiin saldo itu (yang lain: settle via barang, lihat submodule "Penukaran Barang Pasca-Retur") | `ar_return_credits`, dan ke transaksi jurnal |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat retur | `create_ar_credit_note` | Deteksi otomatis financial-only vs full (cek `goods_issues` terkait invoice); insert `ar_credit_notes` + jurnal kontra-revenue (Debit Retur & Potongan Penjualan, Kredit Piutang Usaha); kalau full, insert `inventory_return_lines` per baris (tiap baris punya `condition` — baris Layak Jual masuk lagi ke `inventory_balances`, baris Rusak TIDAK, cost-nya jadi Debit Beban Kerugian Barang Rusak) + jurnal reversal HPP | Trigger `ar_credit_notes_no_over_return` (total retur ≤ `ar_invoices.amount`); trigger `inventory_return_lines_guard` (qty retur ≤ `goods_issue_lines.qty_issued`, jalur full) |
| Deteksi & cairkan excess jadi saldo kredit | `create_ar_credit_note` (lanjutan aksi di atas, 1 pemanggilan) | Hitung `v_remaining_before := ar_invoice_remaining(invoice_id)` sebelum retur masuk; `v_excess := greatest(0, amount − greatest(0, v_remaining_before))`; kalau `> 0`, jurnal tambahan Debit Piutang Usaha / Kredit Saldo Kredit Retur Customer + insert `ar_return_credits` | Param akun liability wajib diisi kalau ada excess |
| Refund tunai saldo kredit retur | `refund_ar_return_credit` | Jurnal Debit Saldo Kredit Retur Customer, Kredit Kas/Bank; insert `ar_return_credit_refunds` | `amount > ar_return_credit_remaining(credit_id)` → tolak |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Retur gak boleh melebihi nilai/qty invoice | Trigger `ar_credit_notes_no_over_return` + `inventory_return_lines_guard` |
| Retur boleh dibuat walau invoice sudah lunas | `create_ar_credit_note` tidak cek status lunas (beda dari `cancel_ar_invoice`) |
| Retur gak boleh masuk periode tertutup | Trigger block-retroactive-period (reuse dari `create_journal_entry`, sama seperti seluruh modul GL) |
| Reversal HPP pakai harga snapshot, bukan harga sekarang | `inventory_return_lines.total_cost` dihitung dari `goods_issue_lines.total_cost` asli, bukan dihitung ulang |
| Excess retur (bikin outstanding negatif) otomatis jadi saldo kredit resmi, bukan cuma angka minus | `create_ar_credit_note` — `v_excess` dihitung dari bagian yang melebihi `v_remaining_before`, bukan seluruh nominal retur |
| Saldo kredit retur cuma bisa refund tunai atau ganti barang, gak bisa dipakai motong invoice lain | Cuma 2 RPC yang bisa mengurangi saldo: `refund_ar_return_credit` dan `create_warranty_replacement` (submodule "Penukaran Barang Pasca-Retur") — tidak ada RPC "terapkan ke invoice lain" |
| Total yang dicairkan/disettle dari saldo kredit retur ≤ sisa saldo | Fungsi `ar_return_credit_remaining(credit_id) = amount − SUM(warranty_replacements.return_credit_settled_amount) − SUM(refunds)` |
| Gak ada batas waktu retur (umur invoice vs tanggal retur) | Sengaja dicabut total — validasi ini sempat ada (per item & per customer), sekarang murni keputusan manual staf di luar sistem |
| Barang Rusak gak boleh balik jadi stok bernilai — kompensasi ke customer tetap jalan, cost-nya jadi kerugian | Kolom `inventory_return_lines.condition` — baris `DAMAGED` skip update `inventory_balances`, cost masuk Debit Beban Kerugian Barang Rusak; kontra-revenue tidak terpengaruh `condition` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `ar_credit_notes` | banyak-ke-satu | `ar_invoices` |
| `inventory_returns` | satu-ke-satu per retur fisik | `ar_credit_notes` |
| `inventory_returns` | banyak-ke-satu | `goods_issues` |
| `inventory_return_lines.total_cost` | snapshot dari | `goods_issue_lines.total_cost` |
| `ar_return_credits` | satu-ke-satu | `ar_credit_notes` (sumbernya) |
| `ar_return_credits` | banyak-ke-satu | `customers` |
| `ar_return_credit_refunds` | banyak-ke-satu | `ar_return_credits` |
| `warranty_replacements.return_credit_settled_amount` (submodule lain) | akumulasi terhadap | `ar_return_credits` (via `ar_credit_notes.credit_note_id`) |

## Penukaran Barang Pasca-Retur (Garansi)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `warranty_replacements` + `warranty_replacement_lines` | Penukaran barang pasca-retur — bukan gratis, tanpa invoice baru, wajib membalikkan diskon retur yang sudah diberikan (proporsional), DAN kalau retur sumbernya punya saldo kredit retur aktif, ikut menyelesaikan saldo itu | `ar_credit_notes` (wajib retur fisik yang sudah ada dulu), `ar_return_credits` (via `ar_credit_notes`, kalau ada), dan ke sampai 3 transaksi jurnal |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat penukaran | `create_warranty_replacement` | Jurnal 1 (selalu): Debit HPP, Kredit Persediaan Barang Jadi, ambil stok dari `inventory_balances`. Jurnal 2 (kalau `v_reversal_amount > 0`): Debit Piutang Usaha, Kredit Retur & Potongan Penjualan, proporsional ke `discount_reversed_amount`. Jurnal 3 (kondisional, kalau credit note punya `ar_return_credits`): Debit Saldo Kredit Retur Customer, Kredit Piutang Usaha, ke `return_credit_settled_amount` | Wajib `credit_note_id` (retur fisik, `inventory_returns` harus ada); trigger `warranty_replacement_lines_no_over_replace` (qty ≤ qty retur); trigger `warranty_replacements_no_over_reverse` (reversal ≤ diskon asli); trigger `warranty_replacements_no_over_settle_return_credit` (settlement ≤ sisa saldo, `raise exception` sebelum jurnal apa pun kalau lebih) |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Wajib menunjuk retur yang sudah ada (retur fisik) | `create_warranty_replacement` — parameter `credit_note_id` wajib, cek eksplisit `exists (select 1 from inventory_returns where credit_note_id = ...)` |
| Reversal diskon gak boleh melebihi diskon asli | Trigger `warranty_replacements_no_over_reverse` (akumulasi per `credit_note_id` ≤ `ar_credit_notes.amount`) |
| Settlement saldo kredit retur gak boleh melebihi sisa saldo | Trigger `warranty_replacements_no_over_settle_return_credit` — `raise exception`, bukan `least()` dipotong diam-diam |
| Barang pengganti dari stok aktif, bukan barang bekas retur | Konsumsi via `inventory_balances` (Weighted Average) — segregasi dijaga logis lewat `condition` di AR Credit Note (baris `DAMAGED` gak pernah masuk pool ini) |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `warranty_replacements` | wajib FK | `ar_credit_notes` |
| `warranty_replacements` | opsional, via `ar_credit_notes.credit_note_id` | `ar_return_credits` |
| `warranty_replacements.discount_reversal_journal_entry_id` | nullable, terisi kalau `discount_reversed_amount > 0` | `journal_entries` |
| `warranty_replacements.return_credit_settlement_journal_entry_id` | nullable, terisi kalau `return_credit_settled_amount > 0` | `journal_entries` |

## Uang Muka / DP (Deposit)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `ar_deposits` | Uang muka/DP diterima sebelum invoice ada | `customers`, dan ke transaksi jurnal (Kas → Uang Muka Penjualan) yang otomatis dibuat |
| `ar_deposit_applications` | DP diterapkan ke invoice yang udah diterbitkan | Menghubungkan `ar_deposits` ↔ `ar_invoices`, dan ke transaksi jurnal reklasifikasi |
| `ar_deposit_refunds` | DP dicairkan tunai kembali ke pelanggan — tidak berdampak Laba Rugi | `ar_deposits`, dan ke transaksi jurnal (Uang Muka Penjualan → Kas) |
| `ar_deposit_forfeitures` | DP dianggap hangus, partial-capable | `ar_deposits`, dan ke transaksi jurnal (Uang Muka Penjualan → Pendapatan Lain-lain) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Terima DP | `create_ar_deposit` | Jurnal Debit Kas/Bank, Kredit Uang Muka Penjualan; insert `ar_deposits` | — |
| Terapkan ke invoice | `apply_ar_deposit` | Jurnal Debit Uang Muka Penjualan, Kredit Piutang Usaha; insert `ar_deposit_applications` | Trigger `ar_deposit_applications_guard` — `amount > ar_deposit_remaining(deposit_id)` → tolak; invoice target harus customer sama & belum dibatalkan |
| Refund tunai | `refund_ar_deposit` | Jurnal Debit Uang Muka Penjualan, Kredit Kas/Bank; insert `ar_deposit_refunds` | Trigger `ar_deposit_refunds_guard` — `amount > ar_deposit_remaining(deposit_id)` → tolak |
| Hanguskan | `forfeit_ar_deposit` | Jurnal Debit Uang Muka Penjualan, Kredit Pendapatan Lain-lain; insert `ar_deposit_forfeitures` | Trigger `ar_deposit_forfeitures_guard` — `amount > ar_deposit_remaining(deposit_id)` → tolak |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| DP gak boleh langsung diakui Pendapatan/pengurang Piutang saat diterima | `create_ar_deposit` — jurnal selalu ke akun Uang Muka Penjualan (liability), bukan Piutang/Pendapatan |
| Total penyelesaian DP (diterapkan + refund + hangus) ≤ nilai DP awal | Fungsi terpusat `ar_deposit_remaining(deposit_id) = amount − SUM(applications) − SUM(refunds) − SUM(forfeitures)`, dipakai ketiga trigger guard |
| Invoice yang DP-nya diterapkan dibatalkan → penerapan DP ikut dibalik | `cancel_ar_invoice` — loop `ar_deposit_applications` aktif milik invoice itu, panggil `reverse_journal_entry` per baris |
| Outstanding buat credit hold ikut ngurangin DP aktif | `create_ar_invoice` — `ar_invoice_remaining()` memasukkan `ar_deposit_applications` sebagai reducer |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `ar_deposits` | banyak-ke-satu | `customers` |
| `ar_deposit_applications` | menghubungkan | `ar_deposits` ↔ `ar_invoices` |
| `ar_deposit_refunds` / `ar_deposit_forfeitures` | banyak-ke-satu | `ar_deposits` |

## Piutang Tak Tertagih (Bad Debt Write-off)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `ar_bad_debt_writeoffs` | Piutang yang benar-benar tidak akan tertagih, dihapusbukukan | `ar_invoices` (1 invoice bisa punya lebih dari satu write-off parsial), dan ke transaksi jurnal (Beban Piutang Tak Tertagih → Piutang Usaha) |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat write-off | `write_off_ar_invoice` | Jurnal Debit Beban Piutang Tak Tertagih (akun expense biasa, bukan kontra), Kredit Piutang Usaha; insert `ar_bad_debt_writeoffs` | Trigger `ar_bad_debt_writeoffs_no_over_writeoff` — `amount > ar_invoice_remaining(invoice_id)` → tolak; invoice yang sudah punya reversal juga ditolak |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Write-off gak boleh melebihi sisa tagihan riil invoice | Trigger `ar_bad_debt_writeoffs_no_over_writeoff` — pakai `ar_invoice_remaining()` (sudah mengurangi payment/retur/DP/write-off lain) |
| Invoice yang sudah punya write-off gak bisa dibatalkan biasa | `cancel_ar_invoice` — cek `count(*) from ar_bad_debt_writeoffs where invoice_id = ...` > 0 → `raise exception` |
| Pendapatan penjualan asli tidak boleh ikut dibalik | `write_off_ar_invoice` tidak menyentuh jurnal invoice asli — jurnal baru terpisah |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `ar_bad_debt_writeoffs` | banyak-ke-satu | `ar_invoices` |

## Kategori Campur & PPN

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `ar_invoice_credit_lines` | Rincian baris kredit (kategori pendapatan + PPN) 1 invoice | `ar_invoices` (banyak-ke-satu) |
| `ar_invoice_charge_types` | Katalog kategori pendapatan tambahan, dipetakan ke akun tetap — master data, bukan tabel transaksional | `accounts` |
| `tax_settings` | Pengaturan PPN — 1 baris untuk seluruh sistem (tarif, status aktif, akun Keluaran/Masukan), dipakai bareng AP/POS | `accounts` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Bikin invoice dengan >1 kategori pendapatan | `create_ar_invoice` (`p_credit_lines` array) | 1 baris jurnal kredit per kategori, insert `ar_invoice_credit_lines` per baris | Minimal 1 baris kategori; Credit Hold dicek terhadap total (subtotal + PPN) |
| Bikin invoice dengan PPN | `create_ar_invoice` (`p_apply_tax=true`) | Tambahan 1 baris kredit PPN Keluaran, dihitung dari `tax_settings.ppn_rate` | Ditolak kalau `tax_settings.is_active=false` atau akun PPN Keluaran belum diset |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Kategori tambahan dipilih dari katalog, bukan akun bebas | Diselesaikan di UI (dropdown `ar_invoice_charge_types`) — RPC sendiri tetap menerima `account_id` mentah, sama seperti akun Piutang/Pendapatan yang sudah ada |
| PPN gak boleh diketik manual | `create_ar_invoice` menghitung sendiri nominal PPN dari `tax_settings`, bukan menerima dari parameter klien |
| Kategori campur tidak mengubah Credit Hold | Perhitungan outstanding tetap pakai total invoice (`v_total_amount`), bukan per-kategori |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `ar_invoice_credit_lines` | banyak-ke-satu | `ar_invoices` |
| `ar_invoice_charge_types` | referensi (dipakai UI, bukan FK langsung) | `ar_invoice_credit_lines` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pelanggan, invoice, pembayaran, uang muka | Semua user yang sudah login |
| Menambah pelanggan baru, mengubah data pelanggan | Role `admin` atau `accountant` |
| Membuat invoice, mencatat pembayaran, mencatat/menerapkan/menghanguskan uang muka, mencatat write-off, refund saldo kredit retur, mencatat penukaran barang | Role `admin` atau `accountant` |
| Mengedit atau menghapus invoice/pembayaran/retur/uang muka/write-off/saldo kredit retur | **Tidak ada seorang pun** — hanya pembatalan/retur lewat jalur resmi yang diizinkan |
| Menghapus data pelanggan secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan |
| Menambah/menonaktifkan kategori pendapatan tambahan, mengubah Pengaturan Pajak | Role `admin` |
