# Compound Line — RPC Transaksional Cuma 1 Debit + 1 Kredit per Panggilan

**Modul asal:** Accounts Payable (Fase 4) — awalnya cuma AP (`ap-bill-compound.md`), digeneralisasi (2026-08-09) begitu ketauan AR Invoice punya batasan struktur identik, dan modul POS (sudah dibangun, lihat [[pos-offline-capability]] dan `memory/domain/pos.md`) warisin batasan yang sama buat kasus non-pajak. **Status:** Ditunda.

## Kasus

3 RPC transaksional inti — `create_ap_bill` (sudah ada), `create_ar_invoice` (sudah ada), dan `create_pos_sale` (POS, sudah ada) — semuanya didesain nerima **1 akun tetap per sisi jurnal** (1 parameter akun debit + 1 parameter akun kredit), bukan array baris kategori. Tapi dunia nyata sering campur kategori dalam 1 dokumen fisik:

- **AP bill**: 1 nota supplier isinya campuran — misal Rp750.000 tepung (Persediaan, asset) + Rp50.000 ongkir (Beban langsung). Sisi kredit (Utang Usaha) selalu 1 baris, tapi sisi debit butuh 2+ kategori.
- **AR invoice**: 1 invoice ke customer bisa campur kategori pendapatan — misal Rp500.000 Pendapatan Penjualan Roti + Rp20.000 Pendapatan Jasa Pengiriman (kalau mau dipisah kategorinya). Sisi debit (Piutang Usaha) selalu 1 baris, tapi sisi kredit butuh 2+ kategori.
- **POS sale**: kemungkinan kasus sama kayak AR invoice tapi kreditnya ke akun Kas, bukan Piutang — misal ongkos packing sebagai kategori pendapatan terpisah. **Update 2026-08-09**: skenario PPN yang tadinya disebut di sini TERNYATA gak nunggu keputusan ini — diselesaikan lewat interim terpisah, lihat [[tax-handling]] (PPN dicatat manual via `create_journal_entry`, bukan parameter compound di `create_pos_sale`). Kasus non-pajak (kategori pendapatan campur, misal ongkir/packing) tetap nunggu keputusan file ini kalau nanti kejadian.

Ketiganya bentuk masalah yang sama: **1 sisi jurnal tetap 1 baris, sisi lainnya butuh N baris kategori** — bukan 3 masalah beda per modul, cuma beda sisi mana yang kena.

## Kenapa ditunda

Ketiga RPC (semuanya sudah ada) sengaja didesain nerima 1 parameter akun tunggal per sisi, walau `create_journal_entry` generik yang jadi fondasinya SUDAH support N baris (`p_lines jsonb` array) — RPC modul-spesifik ini disederhanakan jadi 1:1 pas awal dibangun karena belum ada skenario nyata di cerita bisnis manapun yang butuh kategori campur dalam 1 dokumen.

Belum ada tekanan nyata (AP, AR, maupun POS) yang butuh ini sekarang — didesain kalau muncul skenario nyata (misal supplier yang nota-nya emang campur kategori, atau kebijakan PPN/ongkir yang wajib jadi baris kredit terpisah), bukan spekulatif di muka.

## Opsi desain (belum diputuskan)

- RPC modul nerima `p_lines jsonb` (array baris kategori) buat sisi yang butuh N kategori, mirror `create_journal_entry` — lebih fleksibel, tapi ubah signature RPC yang sudah ada (`create_ap_bill`/`create_ar_invoice`) dan mempengaruhi UI form yang udah jalan.
- Atau tetap 1 akun per dokumen sistem, transaksi campuran dipecah jadi 2+ dokumen logis dengan `source_ref` yang sama (nota/invoice fisiknya 1, tapi beberapa baris dokumen di sistem) — lebih simpel, tapi kurang presisi ke dokumen sumber & butuh input manual 2x per transaksi.

Kalau nanti diputuskan, keputusan yang sama sebaiknya berlaku ke ketiga RPC (AP/AR/POS) sekaligus — supaya gak didesain beda-beda per modul.

**Update 2026-08-10 (Sales Order, migration `0024_sales_orders_schema.sql`):** Sales Order dibangun (`sales_orders`+`sales_order_lines`, cerminan Purchase Order di sisi jual, opsional — lihat `memory/architecture/data/inventory-schema.md` submodule "Sales Order & Pemenuhan Bertahap") **gak menyentuh item ini sama sekali** — SO by design gak pernah bikin journal entry, jadi struktur akun jurnal (yang jadi masalah di sini) gak relevan buat SO. Dibahas eksplisit dan dikonfirmasi gak ada konflik.

Tapi diskusi itu nambah 2 catatan buat kalau item ini digarap nanti (bukan keputusan, cuma antisipasi dampak):
- Kalau Opsi A (`p_lines` array) yang dipilih, `create_ar_invoice` signature berubah (`p_amount`+`p_revenue_account_id` tunggal → `p_credit_lines jsonb`) — ini **breaking change**, beda dari perluasan `so_line_id` di `create_goods_issue` kemarin yang aman (nambah key opsional di dalam jsonb, signature level fungsi gak berubah). `create_goods_issue` (yang manggil `create_ar_invoice`) WAJIB ikut disesuaikan di migration yang sama.
- `sales_order_lines` kemungkinan perlu kolom baru `revenue_account_id` (nullable, per baris item) kalau SO mau tau routing akun pendapatan tiap item saat nanti di-fulfill (misal item "roti" vs item "jasa antar" beda akun) — perluasan kolom, bukan breaking, tapi belum ditambahkan sekarang karena speculative (belum ada skenario nyata, sama alasan item ini sendiri masih Ditunda).

## Kapan perlu digarap

Begitu ada skenario nyata di salah satu modul (nota supplier campur kategori, invoice/POS butuh baris pendapatan/pajak terpisah) yang gak bisa lagi diakali lewat pemisahan dokumen manual.

## Referensi

- `memory/architecture/data/ap-schema.md` (RPC `create_ap_bill`, param `p_debit_account_id`)
- `memory/architecture/data/ar-schema.md` (RPC `create_ar_invoice`, param `p_receivable_account_id`/`p_revenue_account_id`)
- `memory/domain/general-ledger.md` (compound entry generik, `create_journal_entry` `p_lines jsonb`)
- [[pos-offline-capability]] — POS lagi didesain bareng, kemungkinan RPC `create_pos_sale` warisin batasan sama (kecuali kasus PPN, lihat update di atas)
- [[tax-handling]] — kasus PPN spesifik, diselesaikan lewat jalur manual, bukan lewat mekanisme compound file ini
