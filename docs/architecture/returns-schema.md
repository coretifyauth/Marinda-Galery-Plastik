# Retur (Returns) — Struktur Data

Retur barang — baik customer mengembalikan barang yang sudah diinvoice (AR) maupun kita mengembalikan bahan baku ke supplier (AP). Konsep bisnisnya ada di `docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)" untuk sisi AR, dan `docs/domain/accounts-payable.md` bagian "Retur Barang ke Supplier" untuk sisi AP. Detail teknis penuh (DDL, RPC lengkap) ada di `supabase/migrations/0019_returns_schema.sql`.

Tabel ini adalah spine gabungan untuk kedua arah retur: 1 tabel `returns` (dulu `credit_notes`, di-rename biar lebih jelas) dengan kolom `type` (`INBOUND` untuk retur dari customer, `OUTBOUND` untuk retur ke supplier). RPC-nya tetap 2 fungsi terpisah (`create_ar_return`/`create_ap_return`, dulu `create_ar_credit_note`/`create_ap_credit_note`) karena logic bisnisnya beneran beda bentuk, meskipun tempat penyimpanannya sama. Rincian item retur (kedua arah) juga sudah digabung jadi 1 tabel generic `return_lines` — dulu 3 tabel terpisah (`inventory_returns` + `inventory_return_lines` sisi AR, `purchase_return_lines` sisi AP).

**Perubahan penting**: klasifikasi kondisi barang (layak jual/rusak) per baris retur sisi AR **sudah dihapus** — sekarang semua barang retur selalu balik masuk stok. Kalau ada barang yang ternyata rusak, itu ditangani belakangan lewat penyesuaian Stock Opname, bukan bagian dari alur retur lagi (mirror sisi AP yang dari awal memang tidak pernah punya klasifikasi ini).

**Migration final (2026-09-07):** `supabase/migrations/0019_returns_schema.sql` — konsolidasi
dari migration incremental lama (sudah dihapus, historinya ada di `git log`).

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `returns` | Spine — 1 baris = 1 kejadian retur (AR atau AP), nunjuk ke jurnal kontra/pengurang | `transactions` (invoice/bill asal), `journal_entries` |
| `return_lines` | Rincian item retur, kedua arah (AR & AP) — dibedakan kolom `type`, sama seperti `returns` | `returns`, `items`, `goods_notes` (`type='OUTBOUND'`, cuma sisi AR) |

## Retur Barang dari Customer (AR)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `returns` (`type='INBOUND'`) | 1 baris = 1 retur ke customer, nunjuk invoice asal lewat `transaction_id` | `transactions` (invoice), `journal_entries` (jurnal kontra-revenue) |
| `return_lines` (`type='INBOUND'`) | Rincian per item yang diretur fisik — cuma ada kalau invoice-nya lahir dari `create_goods_issue` (lihat `goods-notes-schema.md`) | `returns`, `items`, `goods_notes` (`type='OUTBOUND'`, rujukan snapshot cost) |

**Struktur `returns` (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `type` | `INBOUND` (dari customer) / `OUTBOUND` (ke supplier) | Dicek KEBALIKAN dari jenis transaksi asalnya lewat trigger — beda dari `payments`/`deposits` yang dicek SAMA (lihat "Konsistensi & Guard Lintas Modul") |
| `transaction_id` | Nunjuk invoice (AR) atau bill (AP) asal | Satu kolom referensi ke spine `transactions`, bukan kolom `invoice_id`/`bill_id` terpisah per tipe |
| `amount` | Nominal retur (harga jual, bukan cost) | Wajib > 0; dipakai buat cap total retur terhadap nilai invoice |
| `journal_entry_id` | Jurnal kontra-revenue (Debit Retur & Potongan Penjualan / Kredit Piutang Usaha) | Kalau jalur full, ada jurnal KEDUA (reversal HPP) yang disimpan langsung di tiap baris `return_lines.hpp_reversal_journal_entry_id`, bukan di sini |
| tanpa `counterparty_id` | Customer/supplier selalu diturunkan lewat `transaction_id -> transactions.counterparty_id` | Beda dari `payments`/`return_credits` yang punya `counterparty_id` langsung |

**Struktur `return_lines` (baris `type='INBOUND'`)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `qty_returned` | Qty barang yang balik | Dicek gak boleh melebihi qty yang dulu keluar (`goods_note_lines.qty`) secara akumulatif |
| `total_cost` | Cost barang yang diretur | Dihitung dari **snapshot** unit cost pas barang itu keluar (`goods_note_lines.total_cost / qty`), bukan harga sekarang |
| `condition` | Selalu `RESALABLE` buat baris baru | Kolom historis — dulu bisa `DAMAGED` (barang gak balik masuk stok, cost jadi Beban Kerugian Barang Rusak), klasifikasi ini **sudah dihapus**; baris lama yang masih `DAMAGED` tetap tersimpan apa adanya (data gak diubah), tapi RPC gak pernah menulisnya lagi |
| `goods_issue_id` | Rujukan `goods_notes` (`type='OUTBOUND'`) asal | Cuma keisi baris `type='INBOUND'` — dipakai buat tau snapshot cost mana yang dibalik |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Retur invoice financial-only (barang gak dilacak stok) | `create_ar_return` (param `p_lines` kosong/null) | 1 jurnal: Debit Retur & Potongan Penjualan, Kredit Piutang Usaha, sejumlah `p_amount` (input eksplisit caller) | Trigger `credit_notes_no_over_return` (nama fungsi belum di-rename) — total retur akumulatif gak boleh lebihi `transactions.amount` |
| Retur invoice yang stoknya dilacak (jalur full) | `create_ar_return` (param `p_lines` terisi) | 2 jurnal: kontra-revenue (nominal dari caller) + reversal HPP (nominal dihitung server dari snapshot cost). **Semua baris** masuk lagi ke `inventory_balances` (blend rata-rata tertimbang) — tidak ada lagi baris yang dikecualikan | RPC `raise exception` kalau invoice gak punya `goods_notes` (`type='OUTBOUND'`) sama sekali, atau item yang diretur gak ketemu di `goods_note_lines`-nya |
| Retur yang bikin sisa tagihan invoice jadi negatif (excess) | Bagian dari `create_ar_return`, otomatis | Porsi excess (bukan seluruh nominal retur) direklasifikasi: Debit Piutang Usaha, Kredit Saldo Kredit Retur Customer; insert baris ke `return_credits` (`return-credits-schema.md`) | Dihitung dari sisa tagihan SEBELUM insert retur; wajib isi `p_return_credit_liability_account_id` kalau excess-nya > 0 |
| Cek retur udah pernah "diklaim" lewat penukaran garansi atau sebaliknya | Fungsi bantu (dipakai `warranty_replacements`, lihat `warranty-replacements-schema.md`) | Menjumlahkan qty dari `return_lines` + `warranty_replacements` supaya gak dobel klaim | `sales_returned_qty` join `returns` filter `type='INBOUND'` |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Total retur akumulatif gak boleh lebihi nilai invoice (financial-only) | Trigger `credit_notes_no_over_return` (cap ke `transactions.amount`, bukan sisa outstanding — gak peduli status bayar) |
| Total qty retur gak boleh lebihi qty yang beneran keluar (jalur full) | Trigger `return_lines_no_over_return_inbound` (akumulasi `qty_returned` per item per goods note vs `goods_note_lines.qty`) |
| Retur tetap boleh dibuat walau invoice udah lunas | Tidak ada guard status-bayar sama sekali di RPC/trigger — retur independen dari status pembayaran |
| Reversal HPP pakai harga snapshot asli, bukan harga sekarang | RPC menghitung `v_unit_cost` dari `goods_note_lines.total_cost / qty`, bukan query harga terkini |
| Semua barang retur balik masuk stok tanpa kecuali | RPC gak lagi punya percabangan kondisi — baris rusak ditangani terpisah lewat Stock Opname |
| Excess retur dicairkan otomatis jadi saldo kredit terpisah, bukan dibiarkan jadi angka minus | Hitung `v_excess` dari sisa tagihan sebelum insert, insert `return_credits` kalau > 0 |
| Excess dihitung dari porsi yang beneran melebihi sisa tagihan, bukan seluruh nominal retur | `v_excess := greatest(0, p_amount - greatest(0, v_remaining_before))` |
| Saldo kredit retur gak boleh dipakai motong invoice lain, cuma refund tunai | Dijaga di RPC `return-credits-schema.md` (`refund_return_credit`), bukan di sini |
| Retur gak boleh dicatat ke periode tertutup | Aturan umum integritas pembukuan lewat `create_journal_entry` — tidak ada guard khusus retur yang duplikat |
| Satu barang cuma bisa dikompensasi lewat retur ATAU ganti barang, gak dua-duanya | Guard silang di `warranty_replacements` (`warranty-replacements-schema.md`) yang menghitung sisa qty dari gabungan `return_lines` + `warranty_replacements` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `returns.transaction_id` | banyak-ke-satu | `transactions` (invoice AR) |
| `returns.journal_entry_id` | banyak-ke-satu | `journal_entries` |
| `return_lines.return_id` | banyak-ke-satu | `returns` |
| `return_lines.item_id` | banyak-ke-satu | `items` |
| `return_lines.goods_issue_id` (type INBOUND) | banyak-ke-satu | `goods_notes` (`type='OUTBOUND'`, 1 goods note bisa diretur bertahap) |
| `return_lines.hpp_reversal_journal_entry_id` (type INBOUND) | banyak-ke-satu | `journal_entries` (jurnal reversal HPP, terpisah dari jurnal di `returns`) |
| `returns` (excess) | memicu insert ke | `return_credits` (`return-credits-schema.md`) |
| `returns` | dijadikan basis oleh | `warranty_replacements` (`warranty-replacements-schema.md`) — baris historis nunjuk balik ke sini sebagai bukti fisik barang cacat, baris baru independen |

## Retur Barang ke Supplier (AP)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `returns` (`type='OUTBOUND'`) | 1 baris = 1 retur ke supplier, nunjuk bill asal lewat `transaction_id` | `transactions` (bill), `journal_entries` |
| `return_lines` (`type='OUTBOUND'`) | Rincian item retur — **cuma ada** kalau Opsi A (kurangi utang) DAN bill-nya punya Goods Receipt Note | `returns`, `items` |

Beda dari sisi AR: baris `type='OUTBOUND'` gak pernah punya `goods_issue_id`/`hpp_reversal_journal_entry_id` (2 kolom itu selalu `NULL`) — AP cuma butuh 1 jurnal total (udah nempel di `returns.journal_entry_id`), gak butuh snapshot cost (pakai harga rata-rata **saat ini**). Opsi B (tukar barang) berdiri sendiri di `purchase-replacements-schema.md`, tidak pernah nunjuk ke `returns`/`return_lines` sama sekali.

**Struktur `return_lines` (baris `type='OUTBOUND'`)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `qty_returned` | Qty bahan baku yang dikembalikan | Digabung dengan qty dari `purchase_replacements` (Opsi B) buat cap terhadap qty yang beneran diterima di bill — fungsi gabungan `purchase_returned_qty()` didefinisikan di `purchase-replacements-schema.md` |
| `total_cost` | Cost barang yang diretur, dihitung dari `consume_weighted_average` | Nilai riil yang keluar dari stok, bukan harga bill asal |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Retur ke supplier, financial-only (`p_lines` kosong) | `create_ap_return` | 1 jurnal: Debit Utang Usaha, Kredit akun (Persediaan/Beban tergantung akun bill asal), pakai `p_amount` apa adanya | — |
| Retur ke supplier, Opsi A jalur full (`p_lines` terisi) | `create_ap_return` | Stok dikonsumsi dulu (`consume_weighted_average` per baris, urutan JALAN DULUAN sebelum jurnal dibuat) — `p_amount` dari caller **diabaikan**, diganti hasil penjumlahan cost fisik. 1 jurnal saja: Debit Utang Usaha, Kredit Persediaan Bahan Baku — tidak ada akun kontra karena sisi kredit adalah akun neraca | RPC `raise exception` kalau bill gak punya `goods_notes` (`type='INBOUND'`) |
| Retur bikin outstanding bill jadi negatif (excess) | Bagian dari `create_ap_return`, otomatis | Debit akun asset baru "Piutang Retur Supplier" / Kredit Utang Usaha; insert `return_credits` (`type='OUTBOUND'`) | Dihitung dari `ap_bill_remaining()` sebelum proses; wajib isi `p_return_credit_asset_account_id` kalau excess > 0 |
| Tukar barang ke supplier (Opsi B) | Bukan bagian file ini — lihat `purchase-replacements-schema.md` | Berdiri sendiri, gak pernah insert ke `returns` | — |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Nominal jurnal Opsi A HARUS sama persis nilai barang yang beneran keluar dari stok | RPC mengabaikan `p_amount` di jalur full, memaksa pakai `v_total_cost_returned` hasil `consume_weighted_average` |
| Opsi A tidak butuh akun kontra (beda dari AR) | Sisi debit bill adalah akun neraca (Persediaan), bukan akun laba-rugi — retur langsung mengurangi Persediaan |
| Retur tetap boleh dibuat di semua status bayar bill | Tidak ada guard status-bayar di RPC |
| Excess dari Opsi A direklasifikasi otomatis ke saldo asset terpisah, bukan angka minus | Hitung `v_excess` dari `ap_bill_remaining()` sebelum proses, insert `return_credits` kalau > 0 |
| Total qty Opsi A + Opsi B (gabungan) untuk 1 item di 1 bill gak boleh lebihi qty yang diterima | Fungsi gabungan `purchase_returned_qty()` (didefinisikan di `purchase-replacements-schema.md`, menjumlahkan dari `return_lines` DAN `purchase_replacements`) |
| Saldo Piutang Retur Supplier cuma bisa dicairkan tunai | Dijaga di `return-credits-schema.md`, bukan di sini |
| Retur gak boleh dicatat ke periode tertutup | Aturan umum lewat `create_journal_entry` |
| Opsi C (tulis-jadi-beban tanpa kompensasi) tidak tersedia sebagai jalur retur | Tidak ada RPC/kolom untuk jalur ini — kasus ini ditangani lewat Stock Opname biasa |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `returns.transaction_id` | banyak-ke-satu | `transactions` (bill AP) |
| `return_lines.return_id` | banyak-ke-satu | `returns` (type OUTBOUND) |
| `return_lines.item_id` | banyak-ke-satu | `items` |
| `returns` (excess) | memicu insert ke | `return_credits` (`return-credits-schema.md`) |
| `return_lines` + `purchase_replacements` | digabung lewat fungsi `purchase_returned_qty()` | `purchase-replacements-schema.md` |
| `inventory_movements` | dicatat per baris retur (qty negatif, barang keluar balik ke supplier) | `inventory-ledger-schema.md` |

## Konsistensi & Guard Lintas Modul

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Blokir edit/hapus retur | Trigger `credit_notes_block_edit_delete` (nama belum di-rename) | Semua `UPDATE`/`DELETE` langsung ditolak | Trigger `before update or delete`, reuse fungsi generic `block_edit_delete()` (pola sama `payments`, `deposits`, dll) |
| Pastikan `type` retur **KEBALIKAN** dari transaksi asalnya | Trigger `credit_notes_type_matches_transaction_trigger` | Menolak insert kalau `type` retur SAMA dengan `type` transaksi asalnya — retur adalah pembalikan arah, bukan arah yang sama | Trigger `before insert`; logic ini DIBALIK (dulu cek SAMA) begitu arah `transactions.type` dibalik maknanya, lihat `transactions-schema.md` |
| Sinkronisasi status lunas/sebagian invoice atau bill setelah ada retur | Trigger sync status (reuse `recompute_transaction_status`) | Status invoice/bill dihitung ulang otomatis begitu ada retur baru | Dipanggil dari trigger insert `returns` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `returns` | dibaca reducer | `ar_invoice_remaining()` / `ap_bill_remaining()` (mengurangi sisa tagihan dengan total retur) |
| `returns` | dibaca reducer | `recompute_transaction_status()` (status lunas/sebagian/belum) |
| `returns` (join `return_lines`) | sumber data view | `inventory_movements_with_source` (`inventory-ledger-schema.md`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar retur (AR maupun AP) | Semua user yang sudah login |
| Membuat retur baru (dari customer atau ke supplier) | Role `admin` atau `accountant` |
| Mengubah atau menghapus retur yang sudah tercatat | **Tidak ada seorang pun** — sengaja ditutup total (immutability), koreksi cuma lewat retur/jurnal tambahan, bukan edit langsung |
