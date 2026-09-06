# Credit Notes — Struktur Data

Retur barang — baik customer mengembalikan barang yang sudah diinvoice (AR) maupun kita mengembalikan bahan baku ke supplier (AP). Konsep bisnisnya ada di `docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)" untuk sisi AR, dan `docs/domain/accounts-payable.md` bagian "Retur Barang ke Supplier" untuk sisi AP. Detail teknis penuh (DDL, RPC lengkap) ada di `memory/architecture/data/credit-notes-schema.md`.

Tabel ini adalah spine gabungan untuk kedua arah retur: 1 tabel `credit_notes` dengan kolom `type` (`INBOUND` untuk retur dari customer, `OUTBOUND` untuk retur ke supplier). RPC-nya tetap 2 fungsi terpisah (`create_ar_credit_note`/`create_ap_credit_note`) karena logic bisnisnya beneran beda bentuk, meskipun tempat penyimpanannya sama.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `credit_notes` | Spine — 1 baris = 1 kejadian retur (AR atau AP), nunjuk ke jurnal kontra/pengurang | `transactions` (invoice/bill asal), `journal_entries` |
| `purchase_return_lines` | Rincian item retur sisi AP (Opsi A — kurangi utang), cuma ada kalau bill-nya punya Goods Receipt Note | `credit_notes` (type OUTBOUND), `items` |
| `inventory_returns` | Header retur fisik sisi AR — cuma ada kalau invoice-nya punya Goods Issue | `credit_notes` (type INBOUND), `goods_issues`, `journal_entries` |
| `inventory_return_lines` | Rincian item retur fisik sisi AR, per baris ada klasifikasi kondisi barang | `inventory_returns`, `items` |

## Retur Barang dari Customer (AR)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `credit_notes` (`type='INBOUND'`) | 1 baris = 1 credit note ke customer, nunjuk invoice asal lewat `transaction_id` | `transactions` (invoice), `journal_entries` (jurnal kontra-revenue) |
| `inventory_returns` | Header retur fisik — **cuma dibuat** kalau invoice-nya lahir dari `create_goods_issue` (lihat `goods-issue-schema.md`) | 1:1 ke `credit_notes` yang jadi pasangannya, many:1 ke `goods_issues`, punya `journal_entries` sendiri (jurnal reversal HPP, terpisah dari jurnal kontra-revenue) |
| `inventory_return_lines` | Rincian per item yang diretur fisik, termasuk kondisi barang | `inventory_returns`, `items` |

**Struktur `credit_notes` (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `type` | `INBOUND` (dari customer) / `OUTBOUND` (ke supplier) | Dicek konsisten sama jenis transaksi asalnya lewat trigger |
| `transaction_id` | Nunjuk invoice (AR) atau bill (AP) asal | Satu kolom referensi ke spine `transactions`, bukan kolom `invoice_id`/`bill_id` terpisah per tipe |
| `amount` | Nominal retur (harga jual, bukan cost) | Wajib > 0; dipakai buat cap total retur terhadap nilai invoice |
| `journal_entry_id` | Jurnal kontra-revenue (Debit Retur & Potongan Penjualan / Kredit Piutang Usaha) | Kalau jalur full, ada jurnal KEDUA (reversal HPP) yang disimpan di `inventory_returns.journal_entry_id`, bukan di sini |
| tanpa `counterparty_id` | Customer/supplier selalu diturunkan lewat `transaction_id -> transactions.counterparty_id` | Beda dari `payments`/`return_credits` yang punya `counterparty_id` langsung |

**Struktur `inventory_return_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `qty_returned` | Qty barang yang balik | Dicek gak boleh melebihi qty yang dulu keluar (`goods_issue_lines.qty_issued`) secara akumulatif |
| `total_cost` | Cost barang yang diretur | Dihitung dari **snapshot** unit cost pas barang itu keluar (`goods_issue_lines.total_cost / qty_issued`), bukan harga sekarang |
| `condition` | `RESALABLE` (default) / `DAMAGED` | Menentukan barang balik masuk stok (`RESALABLE`) atau jadi Beban Kerugian Barang Rusak tanpa masuk stok (`DAMAGED`) — bisa campur dalam 1 credit note |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Retur invoice financial-only (barang gak dilacak stok) | `create_ar_credit_note` (param `p_lines` kosong/null) | 1 jurnal: Debit Retur & Potongan Penjualan, Kredit Piutang Usaha, sejumlah `p_amount` (input eksplisit caller) | Trigger `credit_notes_no_over_return` — total retur akumulatif gak boleh lebihi `transactions.amount` |
| Retur invoice yang stoknya dilacak (jalur full) | `create_ar_credit_note` (param `p_lines` terisi) | 2 jurnal: kontra-revenue (nominal dari caller) + reversal HPP (nominal dihitung server dari snapshot cost). Baris `RESALABLE` masuk lagi ke `inventory_balances` (blend rata-rata tertimbang); baris `DAMAGED` gak nyentuh stok, cost-nya masuk akun kerugian (`p_loss_expense_account_id`) | RPC `raise exception` kalau invoice gak punya `goods_issues` sama sekali, atau item yang diretur gak ketemu di `goods_issue_lines`-nya; wajib isi `p_loss_expense_account_id` kalau ada baris `DAMAGED` |
| Retur yang bikin sisa tagihan invoice jadi negatif (excess) | Bagian dari `create_ar_credit_note`, otomatis | Porsi excess (bukan seluruh nominal retur) direklasifikasi: Debit Piutang Usaha, Kredit Saldo Kredit Retur Customer; insert baris ke `return_credits` (`return-credits-schema.md`) | Dihitung dari sisa tagihan SEBELUM insert credit note; wajib isi `p_return_credit_liability_account_id` kalau excess-nya > 0 |
| Cek retur udah pernah "diklaim" lewat penukaran garansi atau sebaliknya | Fungsi bantu (dipakai `warranty_replacements`, lihat `warranty-replacements-schema.md`) | Menjumlahkan qty dari `inventory_return_lines` + `warranty_replacements` supaya gak dobel klaim | `sales_returned_qty` join `credit_notes` filter `type='INBOUND'` |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Total retur akumulatif gak boleh lebihi nilai invoice (financial-only) | Trigger `credit_notes_no_over_return` (cap ke `transactions.amount`, bukan sisa outstanding — gak peduli status bayar) |
| Total qty retur gak boleh lebihi qty yang beneran keluar (jalur full) | Trigger `inventory_return_lines_guard` (akumulasi `qty_returned` per item per goods_issue vs `goods_issue_lines.qty_issued`) |
| Retur tetap boleh dibuat walau invoice udah lunas | Tidak ada guard status-bayar sama sekali di RPC/trigger — retur independen dari status pembayaran |
| Reversal HPP pakai harga snapshot asli, bukan harga sekarang | RPC menghitung `v_unit_cost` dari `goods_issue_lines.total_cost / qty_issued`, bukan query harga terkini |
| Barang rusak gak boleh nambah nilai stok aktif | Percabangan `condition` di loop RPC — cuma baris `RESALABLE` yang `update inventory_balances` |
| Kontra-revenue tetap jalan sama rata terlepas kondisi fisik barang | Jurnal kontra-revenue dibuat sekali di awal RPC, tidak bercabang berdasar `condition` — yang bercabang cuma jurnal HPP |
| Excess retur dicairkan otomatis jadi saldo kredit terpisah, bukan dibiarkan jadi angka minus | Hitung `v_excess` dari sisa tagihan sebelum insert, insert `return_credits` kalau > 0 |
| Excess dihitung dari porsi yang beneran melebihi sisa tagihan, bukan seluruh nominal retur | `v_excess := greatest(0, p_amount - greatest(0, v_remaining_before))` |
| Saldo kredit retur gak boleh dipakai motong invoice lain, cuma refund tunai | Dijaga di RPC `return-credits-schema.md` (`create_ar_return_refund`), bukan di sini |
| Klasifikasi kondisi per baris item, bukan per credit note | Kolom `condition` ada di `inventory_return_lines` (level baris), bukan di `credit_notes`/`inventory_returns` (level header) |
| Retur gak boleh dicatat ke periode tertutup | Aturan umum integritas pembukuan lewat `create_journal_entry` — tidak ada guard khusus retur yang duplikat |
| Satu barang cuma bisa dikompensasi lewat retur ATAU ganti barang, gak dua-duanya | Guard silang di `warranty_replacements` (`warranty-replacements-schema.md`) yang menghitung sisa qty dari gabungan `inventory_return_lines` + `warranty_replacements` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `credit_notes.transaction_id` | banyak-ke-satu | `transactions` (invoice AR) |
| `credit_notes.journal_entry_id` | banyak-ke-satu | `journal_entries` |
| `inventory_returns.credit_note_id` | satu-ke-satu | `credit_notes` (type INBOUND) |
| `inventory_returns.goods_issue_id` | banyak-ke-satu | `goods_issues` (1 goods issue bisa diretur bertahap) |
| `inventory_returns.journal_entry_id` | banyak-ke-satu | `journal_entries` (jurnal reversal HPP, terpisah dari jurnal di `credit_notes`) |
| `inventory_return_lines.inventory_return_id` | banyak-ke-satu | `inventory_returns` |
| `inventory_return_lines.item_id` | banyak-ke-satu | `items` |
| `credit_notes` (excess) | memicu insert ke | `return_credits` (`return-credits-schema.md`) |
| `credit_notes` | dijadikan basis oleh | `warranty_replacements` (`warranty-replacements-schema.md`) — nunjuk balik ke sini sebagai bukti fisik barang cacat |

## Retur Barang ke Supplier (AP)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `credit_notes` (`type='OUTBOUND'`) | 1 baris = 1 credit note ke supplier, nunjuk bill asal lewat `transaction_id` | `transactions` (bill), `journal_entries` |
| `purchase_return_lines` | Rincian item retur — **cuma ada** kalau Opsi A (kurangi utang) DAN bill-nya punya Goods Receipt Note | `credit_notes` (type OUTBOUND), `items` |

Beda dari sisi AR: tidak ada tabel header terpisah semacam `inventory_returns` — `purchase_return_lines` FK langsung ke `credit_notes` karena tidak ada tabel lain yang perlu nunjuk balik ke header retur ini (Opsi B/tukar barang berdiri sendiri di `purchase-replacements-schema.md`, tidak pernah nunjuk ke sini).

**Struktur `purchase_return_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `qty_returned` | Qty bahan baku yang dikembalikan | Digabung dengan qty dari `purchase_replacements` (Opsi B) buat cap terhadap qty yang beneran diterima di bill — fungsi gabungan `purchase_returned_qty()` didefinisikan di `purchase-replacements-schema.md` |
| `total_cost` | Cost barang yang diretur, dihitung dari `consume_weighted_average` | Nilai riil yang keluar dari stok, bukan harga bill asal |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Retur ke supplier, financial-only (`p_lines` kosong) | `create_ap_credit_note` | 1 jurnal: Debit Utang Usaha, Kredit akun (Persediaan/Beban tergantung akun bill asal), pakai `p_amount` apa adanya | — |
| Retur ke supplier, Opsi A jalur full (`p_lines` terisi) | `create_ap_credit_note` | Stok dikonsumsi dulu (`consume_weighted_average` per baris, urutan JALAN DULUAN sebelum jurnal dibuat) — `p_amount` dari caller **diabaikan**, diganti hasil penjumlahan cost fisik. 1 jurnal saja: Debit Utang Usaha, Kredit Persediaan Bahan Baku — tidak ada akun kontra karena sisi kredit adalah akun neraca | RPC `raise exception` kalau bill gak punya `goods_receipt_notes` |
| Retur bikin outstanding bill jadi negatif (excess) | Bagian dari `create_ap_credit_note`, otomatis | Debit akun asset baru "Piutang Retur Supplier" / Kredit Utang Usaha; insert `return_credits` (`type='OUTBOUND'`) | Dihitung dari `ap_bill_remaining()` sebelum proses; wajib isi `p_return_credit_asset_account_id` kalau excess > 0 |
| Tukar barang ke supplier (Opsi B) | Bukan bagian file ini — lihat `purchase-replacements-schema.md` | Berdiri sendiri, gak pernah insert ke `credit_notes` | — |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Nominal jurnal Opsi A HARUS sama persis nilai barang yang beneran keluar dari stok | RPC mengabaikan `p_amount` di jalur full, memaksa pakai `v_total_cost_returned` hasil `consume_weighted_average` |
| Opsi A tidak butuh akun kontra (beda dari AR) | Sisi debit bill adalah akun neraca (Persediaan), bukan akun laba-rugi — retur langsung mengurangi Persediaan |
| Retur tetap boleh dibuat di semua status bayar bill | Tidak ada guard status-bayar di RPC |
| Excess dari Opsi A direklasifikasi otomatis ke saldo asset terpisah, bukan angka minus | Hitung `v_excess` dari `ap_bill_remaining()` sebelum proses, insert `return_credits` kalau > 0 |
| Total qty Opsi A + Opsi B (gabungan) untuk 1 item di 1 bill gak boleh lebihi qty yang diterima | Fungsi gabungan `purchase_returned_qty()` (didefinisikan di `purchase-replacements-schema.md`, menjumlahkan dari `purchase_return_lines` DAN `purchase_replacements`) |
| Saldo Piutang Retur Supplier cuma bisa dicairkan tunai | Dijaga di `return-credits-schema.md`, bukan di sini |
| Retur gak boleh dicatat ke periode tertutup | Aturan umum lewat `create_journal_entry` |
| Opsi C (tulis-jadi-beban tanpa kompensasi) tidak tersedia sebagai jalur retur | Tidak ada RPC/kolom untuk jalur ini — kasus ini ditangani lewat Stock Opname biasa |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `credit_notes.transaction_id` | banyak-ke-satu | `transactions` (bill AP) |
| `purchase_return_lines.credit_note_id` | banyak-ke-satu | `credit_notes` (type OUTBOUND) |
| `purchase_return_lines.item_id` | banyak-ke-satu | `items` |
| `credit_notes` (excess) | memicu insert ke | `return_credits` (`return-credits-schema.md`) |
| `purchase_return_lines` + `purchase_replacements` | digabung lewat fungsi `purchase_returned_qty()` | `purchase-replacements-schema.md` |
| `inventory_movements` | dicatat per baris retur (qty negatif, barang keluar balik ke supplier) | `inventory-ledger-schema.md` |

## Konsistensi & Guard Lintas Modul

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Blokir edit/hapus credit note | Trigger `credit_notes_block_edit_delete` | Semua `UPDATE`/`DELETE` langsung ditolak | Trigger `before update or delete`, reuse fungsi generic `block_edit_delete()` (pola sama `payments`, `deposits`, dll) |
| Pastikan `type` credit note konsisten sama jenis transaksi asalnya | Trigger `credit_notes_type_matches_transaction_trigger` | Menolak insert kalau `type='INBOUND'` nunjuk bill, atau `type='OUTBOUND'` nunjuk invoice | Trigger `before insert` |
| Sinkronisasi status lunas/sebagian invoice atau bill setelah ada retur | Trigger sync status (reuse `recompute_transaction_status`) | Status invoice/bill dihitung ulang otomatis begitu ada retur baru | Dipanggil dari trigger insert `credit_notes` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `credit_notes` | dibaca reducer | `ar_invoice_remaining()` / `ap_bill_remaining()` (mengurangi sisa tagihan dengan total retur) |
| `credit_notes` | dibaca reducer | `recompute_transaction_status()` (status lunas/sebagian/belum) |
| `credit_notes` (join `purchase_return_lines`) | sumber data view | `inventory_movements_with_source` (`inventory-ledger-schema.md`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar credit note (AR maupun AP) | Semua user yang sudah login |
| Membuat credit note baru (retur dari customer atau ke supplier) | Role `admin` atau `accountant` |
| Mengubah atau menghapus credit note yang sudah tercatat | **Tidak ada seorang pun** — sengaja ditutup total (immutability), koreksi cuma lewat retur/jurnal tambahan, bukan edit langsung |
