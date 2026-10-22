# Goods Notes (Penerimaan & Pengiriman Barang) — Struktur Data

Konsep bisnisnya ada di `docs/domain/inventory.md` bagian "Penjualan & Pengakuan HPP" (pengiriman) dan
"Purchase Order & Sales Order (Order) & Penerimaan Barang (3-Way Matching)" (penerimaan). File ini
fokus ke struktur datanya. Detail teknis (SQL, nama fungsi persis) ada di
`supabase/migrations/0018_goods_notes_schema.sql`.

**Migration final (2026-09-07):** `supabase/migrations/0018_goods_notes_schema.sql` —
konsolidasi dari migration incremental lama (sudah dihapus, historinya ada di `git log`).

Goods Note adalah 1 tabel generic buat 2 kejadian fisik yang berlawanan arah, dibedakan kolom `type`
(mirror `transactions-schema.md`): **INBOUND** — dulu disebut Goods Receipt Note (GRN), barang **masuk**
dari supplier, titik di mana Persediaan bertambah dan Utang Usaha muncul. **OUTBOUND** — dulu disebut
Goods Issue, barang jadi **keluar** karena terjual, titik di mana HPP akhirnya diakui (1 transaksi
memicu 2 jurnal sekaligus — Piutang/Pendapatan dari invoice, dan HPP/Persediaan dari konsumsi stok).
Kedua arah boleh berasal dari Order (lihat `orders-schema.md`, `direction='PURCHASE'` buat INBOUND,
`direction='SALE'` buat OUTBOUND) atau dibuat langsung tanpa order. Selalu dibuat bersamaan dengan
transaksi finansialnya (Bill buat INBOUND, Invoice buat OUTBOUND) — lihat `transactions-schema.md`.

Penggabungan tabel ini TIDAK menggabungkan alur pembuatannya — masih 2 RPC terpisah
(`create_goods_receipt` buat INBOUND, `create_goods_issue` buat OUTBOUND) karena efek jurnalnya
beneran beda (INBOUND cuma update Persediaan, OUTBOUND bikin 2 jurnal Piutang+HPP). Yang digabung
cuma tabel penyimpanannya.

> **Status (2026-10-22): sisi INBOUND dirancang ulang — migration `0056_goods_received_not_invoiced.sql`
> sudah ditulis dan lulus tes di database lokal, BELUM diapply ke database live.** Barang masuk dipisah dari
> tagihan (Barang Masuk Belum Ditagih) — lihat section `## Barang Masuk Belum Ditagih (rencana)` di
> bawah. **Selama migration-nya belum diapply, tabel dan RPC INBOUND di section lain di file ini
> (barang masuk otomatis membuat tagihan) masih yang berlaku di database live.** Sisi OUTBOUND tidak
> berubah. Konsep bisnis: `docs/domain/inventory.md` submodule "Barang Masuk Belum Ditagih".

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `goods_notes` | Header bukti penerimaan/pengiriman barang, dibedakan `type` | `transactions-schema.md` (wajib), Journal Entry (wajib cuma OUTBOUND), `orders-schema.md` (opsional) |
| `goods_note_lines` | Baris item yang diterima/keluar (qty & biaya) | `goods_notes`, `orders-schema.md` (opsional), `items-schema.md` |

## Konsep Inti

**Struktur `goods_notes`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `type` | `INBOUND` (dulu GRN) atau `OUTBOUND` (dulu Goods Issue) | Menentukan arah fisik & kolom mana yang wajib terisi |
| `transaction_id` | Tagihan (Bill, INBOUND) atau Invoice (OUTBOUND) yang dibuat bersamaan | **Selalu wajib** — tiap Goods Note pasti punya transaksi pasangannya |
| `journal_entry_id` | Jurnal HPP (Debit HPP, Kredit Persediaan Barang Jadi) | Wajib diisi **HANYA OUTBOUND** — INBOUND selalu NULL karena jurnal Persediaan udah tercakup di jurnal transaksinya sendiri, bukan cacat data |
| `source_ref` | Nomor dokumen internal | Wajib diisi **HANYA OUTBOUND** — INBOUND gak pernah punya nomor dokumen sendiri (cukup `delivery_note_ref` + nomor Bill-nya) |
| `order_id` | Order asal, kalau ada | Opsional — INBOUND harus dari Purchase Order kalau diisi, OUTBOUND harus dari Sales Order |
| `delivery_note_ref` | Nomor Surat Jalan dari counterparty | Murni catatan referensi teks — dalam praktiknya cuma keisi sisi INBOUND |
| `note_date` | Tanggal kejadian fisik (terima/kirim) | — |

**Struktur `goods_note_lines`**

| Kolom | Isinya | Catatan |
|---|---|---|
| `order_line_id` | Baris Order asal, kalau ada | Opsional — kalau kosong, jalur langsung tanpa order |
| `item_id`, `qty` | Barang, qty yang diterima/dikirim | — |
| `unit_cost` | Harga beli riil per unit | Wajib diisi **HANYA INBOUND** — input manual, boleh beda dari harga di order line (selisih murni informasional) |
| `total_cost` | Total biaya pokok (extended, bukan per-unit) | Wajib diisi **HANYA OUTBOUND** — dihitung dari harga rata-rata tertimbang saat konsumsi (Weighted Average, `inventory-ledger-schema.md`), bukan input manual |
| `unit_price` | Harga jual per unit | Cuma keisi sisi OUTBOUND jalur langsung (POS/walk-in tanpa Sales Order) — kalau ada `order_line_id`, harga tetap bersumber dari `order_lines.unit_price` |
| `discount_rule_id`, `discount_amount` | Diskon barang (lihat `promotion-item-discount-rules-schema.md`) | **OUTBOUND**: resolusi FRESH dari aturan aktif saat baris ini dibuat (bukan diwarisi dari `order_lines`), sudah baked-in ke `unit_price`/jumlah yang dikirim ke `create_goods_issue` — murni audit trail. **INBOUND**: porsi dari diskon header (nominal manual admin, lihat submodule "Diskon Pembelian" di bawah) yang diproratakan `create_goods_receipt` ke baris ini berdasar `qty * unit_cost` — satu-satunya kasus di mana kolom ini dipakai buat aritmatika (mengoreksi `avg_cost`) |
| `bundle_promo_rule_id` | "Beli N Gratis X" (lihat `promotion-bundle-rules-schema.md`) | Cuma OUTBOUND — `discount_amount` di atas bisa nampung kontribusi dari `promotion_item_discount_rules` DAN `promotion_bundle_rules` sekaligus (dijumlah, dibatasi gak lebih dari `qty*unit_price` baris itu). Dari jalur POS, diisi `create_pos_sale` sendiri (server-side); dari Sales Order/Goods Issue manual, dari resolusi TypeScript client (informational, sama pola `discount_rule_id`) |
| `manual_discount_amount` | Diskon manual kasir POS (lihat `pos-schema.md` bagian "Diskon Manual Kasir") | Cuma OUTBOUND dari POS, default `0`, `CHECK >= 0`. **Terpisah dari `discount_amount`** (diskon otomatis) biar laporan bisa membedakan potongan promo vs nego kasir. Porsi baris ini dari 1 nominal per transaksi, dibagi proporsional oleh `create_pos_sale`. Sudah baked-in ke jurnal (murni audit trail); kasirnya = `goods_notes.created_by` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat penerimaan barang (INBOUND, + tagihan sekaligus) | `create_goods_receipt` | 1 panggilan: (1) tentukan supplier — dari order kalau diisi, atau manual kalau langsung; (2) diskon header (`p_discount_amount`, opsional) diproratakan per baris berdasar `qty * unit_cost`, sisa pembulatan dibebankan ke baris terakhir; (3) bikin Bill + jurnal Debit Persediaan (sudah net diskon)/Kredit Utang Usaha; (4) insert `goods_notes`(`type='INBOUND'`)+`goods_note_lines`; (5) hitung ulang `avg_cost` & update saldo Persediaan per item pakai harga NET (setelah diskon per baris) | Order tujuan (kalau diisi) harus Purchase Order dan belum dibatalkan; qty diterima per baris order gak boleh melebihi sisa dipesan; jalur langsung wajib supplier manual; diskon gak boleh melebihi subtotal pembelian |
| Batalkan penerimaan barang (INBOUND) | `cancel_ap_bill` (tagihan pasangannya; migration `0052`) | Jurnal tagihan dibalik; tiap baris: `qty_on_hand` dikurangi, `avg_cost` = (nilai persediaan sekarang − nilai bersih baris GRN) / qty sisa, mutasi kompensasi (qty negatif) ke Kartu Stok; status Purchase Order dihitung ulang. Status "dibatalkan" GRN diturunkan dari status tagihannya (tabel immutable, gak ada kolom status) | Ditolak kalau tagihan punya pembayaran/retur/DP/tukar barang, sudah pernah dibatalkan, atau stok item tinggal < qty diterima. HPP penjualan yang sudah dijurnal di antara tidak di-restate. Retur baru di atas tagihan yang sudah dibatalkan ditolak trigger di tabel `returns`. Kartu Stok melabeli mutasi kompensasinya "Pembatalan Barang Masuk". Qty GRN dibatalkan gak dihitung lagi sebagai "sudah diterima" di PO (trigger anti-over-fulfill, `recompute_order_status`, `cancel_order`) |
| Batalkan pengiriman barang (OUTBOUND) | `cancel_ar_invoice` (invoice pasangannya; migration `0052`) | Jurnal invoice + jurnal HPP dibalik; tiap baris: `qty_on_hand` ditambah balik (`avg_cost` tetap — konsumsi gak pernah mengubahnya), mutasi kompensasi (qty positif) ke Kartu Stok berlabel "Pembatalan Barang Keluar"; status Sales Order dihitung ulang | Ditolak kalau invoice punya pembayaran/retur/penggantian barang atau sudah pernah dibatalkan. Qty yang dibatalkan dibebaskan dari SO. Invoice POS yang sudah lunas tetap lewat `void_pos_transaction` |
| Catat pengiriman barang (OUTBOUND, + invoice + pengakuan HPP sekaligus) | `create_goods_issue` | 1 panggilan: (1) bikin invoice + jurnal Debit Piutang/Kredit Pendapatan (nilai per baris sudah net diskon, dihitung & dikirim client sebelum RPC dipanggil); (2) konsumsi tiap barang jadi dari stok (Weighted Average, gak kepengaruh diskon jual — HPP soal cost barang keluar, bukan harga jual); (3) bikin jurnal **kedua** — Debit HPP, Kredit Persediaan Barang Jadi; (4) insert `goods_notes`(`type='OUTBOUND'`)+`goods_note_lines` (termasuk `discount_rule_id`/`discount_amount` per baris, audit trail); (5) catat mutasi keluar ke Kartu Stok | Sales Order tujuan (kalau diisi) harus `direction='SALE'` dan belum dibatalkan; qty keluar per baris order gak boleh melebihi sisa dipesan; qty keluar gak boleh melebihi stok tersedia |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| HPP diakui persis pas barang jadi keluar, bukan pas utang dibayar atau pas barang diproduksi | `create_goods_issue` selalu bikin jurnal HPP di titik ini, terpisah dari jurnal invoice |
| Pembelian selalu masuk Persediaan (aset), gak pernah langsung jadi Beban | `create_goods_receipt` selalu mengarah ke akun Persediaan sebagai debit utama |
| Pengurangan/penambahan stok gak boleh melebihi batas wajar | Weighted Average menolak konsumsi kalau saldo gak cukup; trigger anti-over-fulfill menolak qty yang ngelewatin sisa order |
| Penerimaan/pengiriman dari Order gak boleh melebihi qty yang masih tersisa dari yang dipesan | 1 trigger anti-over-fulfill generic, bandingkan total sudah terpenuhi + qty baru terhadap `qty_ordered`, per baris order — otomatis cuma bandingin 1 arah karena `order_line_id` gak bisa dipakai lintas arah |
| Jalur langsung tanpa Order gak punya batas pembanding | Trigger anti-over-fulfill di-skip total kalau baris gak menunjuk order line |
| Order cuma bisa dipakai sesuai arahnya (INBOUND cuma dari PO, OUTBOUND cuma dari SO) | Trigger yang menolak `order_id`/`order_line_id` menunjuk order dengan `direction` yang salah — berlaku di level header DAN baris |
| Order yang sudah dibatalkan gak bisa jadi dasar Goods Note baru | Guard di awal kedua RPC — cek `cancelled_at` order sebelum lanjut |
| Tiap transaksi harus tertelusur ke dokumen sumber | `transaction_id` wajib diisi di `goods_notes`, gak pernah berdiri sendiri |
| Data yang sudah tercatat gak boleh diubah/dihapus diam-diam | Trigger immutability pada `goods_notes` dan `goods_note_lines` |
| Diskon penjualan gak pernah jadi baris jurnal terpisah (trade discount) | `create_goods_issue` cuma menyimpan `discount_rule_id`/`discount_amount`/`manual_discount_amount` per baris (audit trail) — nilai yang dijurnal sudah net dari `p_credit_lines`, RPC gak menghitung ulang. `transactions.discount_amount` mengakumulasi `discount_amount` + `manual_discount_amount` |
| Diskon pembelian gak boleh bikin nilai Persediaan (GL) menyimpang dari valuasi Kartu Stok (`avg_cost`) | `create_goods_receipt` memprorata `p_discount_amount` ke tiap baris SEBELUM menghitung `avg_cost`, bukan cuma mengurangi angka agregat |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `goods_notes.transaction_id` | banyak-ke-satu (wajib) | `transactions` (lihat `transactions-schema.md`) |
| `goods_notes.journal_entry_id` | banyak-ke-satu (wajib cuma OUTBOUND) | Journal Entry (`journal-entry-schema.md`) |
| `goods_notes.order_id` | banyak-ke-satu (opsional) | `orders` (arah harus cocok `type`) |
| `goods_note_lines.goods_note_id` | banyak-ke-satu | `goods_notes` |
| `goods_note_lines.order_line_id` | banyak-ke-satu (opsional) | `order_lines` (arah harus cocok `type` header) |
| `goods_note_lines.item_id` | banyak-ke-satu | `items` |
| `goods_note_lines.discount_rule_id` | banyak-ke-satu, opsional | `promotion_item_discount_rules` (`promotion-item-discount-rules-schema.md`), cuma keisi buat `type='OUTBOUND'` |
| `goods_note_lines.bundle_promo_rule_id` | banyak-ke-satu, opsional | `promotion_bundle_rules` (`promotion-bundle-rules-schema.md`), cuma keisi buat `type='OUTBOUND'` |
| `goods_note_lines` (tiap insert) | memicu update/konsumsi | Saldo stok (`inventory-ledger-schema.md`) |

Catatan lintas modul: retur customer (pembalikan stok+HPP dari OUTBOUND) dan retur ke supplier
(pembalikan dari INBOUND) didokumentasikan di `returns-schema.md`/`return-credits-schema.md`, bukan
di sini. Tukar/ganti barang pasca-retur (Opsi B, kedua arah) di `replacements-schema.md`.

## Barang Masuk Belum Ditagih (rencana)

Konsep bisnis: `docs/domain/inventory.md` submodule "Barang Masuk Belum Ditagih". **Belum diimplementasi** — migration-nya baru ditulis setelah dokumen ini disetujui, diuji di database lokal (bukan database live), lalu direview `schema-reviewer`. Cakupan: penerimaan langsung tanpa Purchase Order (jalur PO ikut RPC yang sama).

### Keputusan

- Barang masuk (INBOUND) **tidak lagi membuat tagihan**. Tagihan dibuat terpisah, dari satu atau beberapa barang masuk milik supplier yang sama.
- Tabel `goods_notes` dan `goods_note_lines` tetap immutable. Semua yang berubah sesudah dibuat (revisi harga/diskon, status tertagih, pembatalan) dicatat sebagai **baris baru di tabel pendamping**, bukan UPDATE.
- `avg_cost` hanya dihitung dari barang yang sudah ditagih. Barang masuk belum ditagih menambah qty stok tapi **tidak** menggeser `avg_cost`. Selama masa tunggu, penjualan memakai `avg_cost` terakhir.
- Aturan "`avg_cost` nol tidak bisa dijual" ditegakkan di satu tempat: fungsi konsumsi stok bersama.
- Revisi harga/diskon sebelum ditagih = jurnal lama dibalik + jurnal baru; **tidak menyentuh stok atau `avg_cost`**.
- Hanya satu akun baru: **Barang Diterima Belum Ditagih** (kewajiban perantara). Tanpa akun Selisih Harga Pembelian.
- Tidak ada perubahan pada database live sampai migration lolos uji lokal dan review, dan user yang menjalankan apply.

### Peta Data (ERD) — tabel baru/berubah

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `goods_notes` (INBOUND) | Kolom baru `counterparty_id` (supplier; wajib untuk INBOUND) dan `inbound_flow`: `bundled` = alur lama (dibuat bareng tagihan, `transaction_id` terisi, `journal_entry_id`/`source_ref` kosong, jurnal ada di tagihan), `deferred` = alur baru (`transaction_id` kosong, `source_ref` = nomor barang masuk dari penomoran dokumen tipe `goods_receipts`/`GRN`, `journal_entry_id` terisi kecuali nilainya 0). `transaction_id`, `journal_entry_id`, `source_ref` wajib hanya untuk OUTBOUND | `counterparties` |
| `goods_note_lines` (INBOUND) | `unit_cost` boleh 0 (sekarang harus > 0). `discount_amount` per baris diisi dari input diskon per item + sisa diskon header yang diproratakan | — |
| `goods_note_revisions` + `goods_note_revision_lines` (baru) | Riwayat revisi harga/diskon, 1 header per revisi (nomor revisi 2, 3, …; revisi 1 = nilai asli di `goods_note_lines`), menyimpan jurnal baru dan jurnal pembalik revisi sebelumnya | `goods_notes`, `goods_note_lines`, `journal_entries` |
| `goods_note_billings` (baru) | Penghubung barang masuk → tagihan (1 baris per barang masuk yang ditagih). Pengganti `goods_notes.transaction_id` untuk INBOUND | `goods_notes`, `transactions` |
| `goods_note_billing_allocations` (baru) | Per (penagihan, item): foto kondisi stok sebelum dan sesudah ditagih (`avg_cost`, `qty_on_hand`, `qty_unbilled`, `spill_value`), qty yang masih ada vs yang sudah terjual duluan, dan koreksi HPP beserta nomor jurnalnya. Dipakai membatalkan tagihan dengan persis | `goods_note_billings`, `items` |
| `goods_note_cancellations` (baru) | Penanda barang masuk belum ditagih yang dibatalkan, beserta jurnal pembaliknya | `goods_notes`, `journal_entries` |
| `inventory_balances` (kolom baru) | `qty_unbilled`, `spill_value` — lihat `inventory-ledger-schema.md` | `items` |
| Default Akun (kunci baru) | `inventory.goods_received_not_invoiced` → akun Barang Diterima Belum Ditagih | `default-account-settings-schema.md` |

### Status turunan barang masuk (INBOUND)

Dihitung lewat view `goods_notes_with_billing_status` (`security_invoker = true`), bukan kolom:

| Status | Syarat |
|---|---|
| `dibatalkan` | Ada baris di `goods_note_cancellations` |
| `tertagih` | Ada baris di `goods_note_billings` yang tagihannya **tidak dibatalkan** (jurnal tagihan belum dibalik) |
| `belum_tertagih` | Bukan keduanya. Daftar barang masuk menandai merah, dengan umur (`current_date − note_date`) |

Data lama: seluruh 16 INBOUND yang ada sudah punya tagihan, jadi di-backfill ke `goods_note_billings` (dan `counterparty_id` diambil dari tagihannya). Backfill menyentuh tabel immutable, jadi trigger blok-edit dimatikan sebentar di dalam migration (pola yang sama dengan `0042`) dan dinyalakan lagi.

### Biaya berlaku per baris

Revisi 1 = `unit_cost` dan `discount_amount` asli di `goods_note_lines`; revisi N ≥ 2 = baris di `goods_note_revision_lines`. View `goods_note_line_current_cost` memberi nilai terbaru:
`nilai_baris = qty × unit_cost − discount_amount`, `net_unit_cost = nilai_baris ÷ qty`, dan **nilai barang masuk `V` = jumlah `nilai_baris`**. Barang masuk dengan `V = 0` tidak punya jurnal.

### Alur Teknis (RPC)

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat barang masuk | `create_goods_receipt` (signature baru, tanpa parameter tagihan) | (1) nomor dokumen; (2) insert `goods_notes` + `goods_note_lines`; diskon per item dipakai apa adanya, diskon header yang tersisa diproratakan per baris sebanding `qty × unit_cost` (sisa pembulatan ke baris terakhir); (3) kalau `V > 0`: jurnal Debit Persediaan / Kredit Barang Diterima Belum Ditagih; (4) Kartu Stok +qty; (5) `inventory_balances`: `qty_on_hand += qty`, `qty_unbilled += qty`, **`avg_cost` tidak berubah** (baris baru dibuat dengan `avg_cost = 0` kalau item belum punya saldo) | Supplier valid; PO (kalau ada) belum dibatalkan, qty ≤ sisa; `unit_cost ≥ 0`; harga net per baris ≥ 0; diskon tidak melebihi nilai baris |
| Revisi harga/diskon | `revise_goods_receipt` | Hanya barang masuk **belum tertagih dan belum dibatalkan**. Membalik jurnal yang berlaku (lewat `reverse_journal_entry`, bertanggal hari revisi) lalu memposting jurnal baru dari nilai terbaru (dilewati kalau `V = 0`). Insert baris revisi. **Stok dan `avg_cost` tidak disentuh** | Tanggal revisi tidak boleh di periode tertutup; hanya harga, diskon, dan nomor surat jalan — bukan item atau qty |
| Batalkan barang masuk | `cancel_goods_receipt` | Hanya yang belum tertagih. Membalik jurnal berlaku, `qty_on_hand −= qty` dan `qty_unbilled −= qty`, Kartu Stok kompensasi, insert `goods_note_cancellations`. Status Purchase Order dihitung ulang | Semua qty barang masuk itu **masih ada** di stok (tidak ada yang sudah terjual lewat aturan penjualan-di-masa-tunggu di bawah); stok item ≥ qty |
| Buat tagihan dari barang masuk | `create_ap_bill_from_goods_receipts` | Memilih barang masuk (supplier sama, semua belum tertagih, nilai semua baris > 0). Membuat tagihan lewat `create_transaction('INBOUND', …)` dengan baris debit Barang Diterima Belum Ditagih sebesar `ΣV` (ditambah baris biaya tambahan dan PPN seperti tagihan biasa) lawan Utang Usaha. Insert `goods_note_billings` + `goods_note_billing_allocations`. Per item: hitung ulang `avg_cost` dan `qty_unbilled` (rumus di bawah). Kalau ada selisih unit yang sudah terjual: 1 jurnal koreksi HPP lawan Persediaan | Satu supplier; tiap barang masuk ditagih utuh dan paling banyak satu tagihan aktif; tidak ada barang masuk berharga 0 |
| Batalkan tagihan dari barang masuk | `cancel_ap_bill` (diperluas) | Memulihkan **persis** kondisi sebelum ditagih dari `goods_note_billing_allocations` (`avg_cost`, `qty_unbilled`, `spill_value`), membalik jurnal tagihan dan jurnal sisa HPP (kalau ada). Barang masuk kembali `belum_tertagih`, stok tidak dibalik | Guard lama (pembayaran/retur/DP/tukar barang) tetap. **Baru:** ditolak kalau saldo salah satu item sudah berubah dari kondisi tepat setelah ditagih (`qty_on_hand`, `qty_unbilled`, `avg_cost`, `spill_value` tidak lagi sama dengan yang tercatat di foto penagihan) — pemulihan persis hanya valid kalau stok belum bergerak; pakai Retur |
| Konsumsi stok | `consume_weighted_average` (diperluas) | Lihat `inventory-ledger-schema.md` | Ditolak kalau `avg_cost = 0` |
| Retur ke supplier | `create_ap_return` (ditulis ulang) | Mengambil seluruh barang masuk di tagihan, bukan satu | Qty retur ≤ total qty diterima semua barang masuk tagihan itu per item |

### Rumus penagihan (per item)

Notasi untuk satu item: `Q` = `qty_on_hand`, `U` = `qty_unbilled`, `P = Q − U` (stok yang sudah ditagih), `avg` = `avg_cost`, `SV` = `spill_value`.

1. **Urutan barang masuk belum ditagih** untuk item itu: `note_date`, lalu `created_at`, lalu `id` (paling lama dulu), tidak termasuk yang dibatalkan atau yang sudah ditagih.
2. **Qty terjual duluan** `S = (jumlah qty semua barang masuk belum ditagih item itu) − U`. `S` diturunkan, tidak disimpan.
3. **Alokasi ke tiap barang masuk** `k` (urutan paling lama dulu): `a_k = min(q_k, max(0, S − jumlah q barang masuk yang lebih lama))`, dan `r_k = q_k − a_k` = qty yang masih ada fisik.
4. Untuk barang masuk yang dipilih `B`: `r = Σ r_j`, `a = Σ a_j`, nilai sisa `A = Σ r_j × net_unit_cost_j`, `avgspill = SV ÷ S` (kalau `S > 0`), `delta = Σ a_j × (net_unit_cost_j − avgspill)`.
5. **Stok yang tersisa dinilai dengan harga nota:** kalau `P + r > 0`, `avg_baru = (P × avg + A) ÷ (P + r)`; kalau `P + r = 0`, `avg` tidak berubah. Lalu `U -= r` dan `SV -= a × avgspill`.
6. **Selisih unit yang sudah terjual (`delta`) dijurnal sebagai koreksi HPP di periode tagihan** (bukan mengubah HPP lama): `delta > 0` → Debit HPP / Kredit Persediaan; `delta < 0` → Debit Persediaan / Kredit HPP; `delta = 0` → tidak ada jurnal. Jurnal ini 1 per penagihan (semua item digabung per akun), sumbernya tagihan itu, dan dibalik bersama tagihan kalau dibatalkan.

> **Kenapa selisih tidak "ditanggung stok tersisa":** aturan itu sempat dirancang (selisih ditambahkan ke nilai stok yang tersisa, `avg_baru = (P × avg + A + delta) ÷ (P + r)`), tapi simulasi acak (`1 juta+ operasi`, 2026-10-22) menunjukkan `avg_cost` bisa jadi **negatif** atau melonjak kalau sebagian besar unit sudah terjual sebelum tagihan dan harga nota beda jauh dari `avg_cost` saat itu (pembagi `P + r` kecil). Dengan koreksi ke HPP, `avg_baru` selalu rata-rata tertimbang dari `avg` dan harga nota (tidak pernah negatif), dan semua invarian di bawah tetap terjaga.

### Invarian yang wajib terjaga (dipakai sebagai tes)

1. `0 ≤ U ≤ Q` dan `SV ≥ 0` untuk setiap item.
2. Saldo akun Barang Diterima Belum Ditagih = jumlah `V` semua barang masuk yang belum ditagih dan belum dibatalkan.
3. Nilai Persediaan per item di buku besar = `P × avg + Σ V (barang masuk belum ditagih item itu) − SV`. Kalau semua sudah ditagih (`U = 0`) maka = `Q × avg` (selisih pembulatan sen diterima).
4. Tiap jurnal seimbang (debit = kredit); tidak ada baris jurnal bernilai 0.
5. Item dengan `avg = 0` tidak bisa dikonsumsi lewat jalur apa pun.
6. Satu barang masuk paling banyak punya satu penagihan aktif.

### Dampak ke fungsi lain (cek dampak)

| Fungsi/area | Perubahan |
|---|---|
| `consume_weighted_average` (produksi, Goods Issue, POS, tukar barang, retur ke supplier) | Tolak kalau `avg = 0`. Konsumsi menghabiskan stok sudah-ditagih lebih dulu; kelebihannya (`y`) mengurangi `U` dan menambah `SV` sebesar `y × avg` |
| Hasil produksi (`0011`) | Campur `avg_cost` memakai `P` (bukan `Q`): `(P×avg + qty×biaya) ÷ (P + qty)` |
| Stock opname (`0012`) | Kekurangan diperlakukan seperti konsumsi (pembagian pool dan `SV`); kelebihan menambah stok sudah-ditagih pada `avg` yang ada |
| Stok yang kembali: pembatalan/void penjualan (`cancel_ar_invoice`, `void_pos_transaction`), retur dari customer (`create_ar_return`) | Lewat fungsi baru `inventory_restore_stock`: unit yang dulu terjual duluan dari barang masuk belum ditagih diisi kembali **lebih dulu** ke `U` (dan `SV` dikurangi sebesar rata-rata nilai spill), sisanya masuk stok sudah-ditagih. Retur dari customer mencampur `avg_cost` hanya dengan bagian yang masuk stok sudah-ditagih. Tanpa ini, tagihan sesudahnya menjurnal koreksi HPP untuk penjualan yang sudah dibatalkan |
| Tukar barang ke supplier (`create_replacement` OUTBOUND) | Konsumsi barang rusak + masuknya barang pengganti ke stok sudah-ditagih (`inventory_add_billed`); jurnalnya net nol di Persediaan sehingga invarian tetap terjaga |
| Pembatalan penerimaan lama (`0052`/`0053`) | Jalur untuk barang masuk lama (sudah punya tagihan) tetap, tapi rumus `avg_cost` memakai `P` |
| `recompute_transaction_status` dan klasifikasi asal tagihan (`0015`) | Membaca `goods_note_billings`, bukan `goods_notes.transaction_id`, untuk INBOUND |
| Halaman aplikasi | Form barang masuk, form tagihan (mode "dari barang masuk"), daftar barang masuk (penanda merah), form retur ke supplier, halaman Purchase Order → terima barang |

### Keterbatasan yang diketahui (dari review schema 2026-10-22)

- **Pembatalan tagihan harus berurutan terbalik (LIFO) per item.** Menagih barang masuk lain untuk item yang sama mengubah `avg_cost`/`qty_unbilled`, jadi tagihan sebelumnya baru bisa dibatalkan setelah yang terbaru dibatalkan.
- **Unit yang terjual duluan lewat jalur non-penjualan** (produksi, retur ke supplier, opname, tukar barang) tetap dikoreksi ke akun HPP dan memakai akun Persediaan milik item (`items.inventory_account_id`) saat tagihan dibuat. Jurnal tetap seimbang, tapi klasifikasinya HPP, bukan nilai barang jadi/akun lain. Diterima sebagai batasan.
- **Barang masuk bernilai 0 tidak punya jurnal**, jadi penjagaan periode tertutup untuk mereka dicek langsung (`assert_period_open`) di barang masuk, revisi, dan pembatalan.
- **Item dengan `avg_cost = 0` dan stok > 0** langsung tidak bisa dijual/diproduksi/diretur/dioname begitu migration aktif. Wajib dicek di database live sebelum apply.
- **Deploy harus serempak dengan perubahan aplikasi:** RPC `create_goods_receipt` lama (12 argumen) di-drop, jadi UI lama yang memanggilnya akan error begitu migration diapply.

### Keputusan teknis yang perlu disetujui

- **Pembatalan tagihan ditolak kalau stok item sudah bergerak sejak ditagih.** Ini batasan baru di atas keputusan "tagihan dibatalkan → barang masuk kembali belum tertagih": `avg_cost` pasca-penagihan sudah bercampur dengan transaksi sesudahnya, jadi tidak bisa dipulihkan persis.
- **`spill_value` dialokasikan berdasar rata-rata** (`SV ÷ S`) lintas barang masuk yang kena, bukan per transaksi penjualan. Total nilainya tetap terjaga persis; hanya pembagian antar barang masuk yang berbasis rata-rata.
- **Selisih unit yang sudah terjual dikoreksi ke HPP periode tagihan, bukan ditanggung stok tersisa** (perubahan dari kesepakatan sebelumnya — alasan di catatan pada "Rumus penagihan"). HPP penjualan lama tetap tidak diubah.

**Bukti uji model (simulasi acak, 2026-10-22):** rumus di atas dijalankan pada urutan acak barang masuk (termasuk harga 0), revisi harga, penjualan, penagihan sebagian, pembatalan, hasil produksi, dan opname — lebih dari 1 juta operasi, semua invarian terjaga (`scratchpad` sesi, bukan bagian repo). Pengujian sebenarnya tetap di database lokal setelah migration ditulis.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar penerimaan/pengiriman barang | Semua user yang sudah login |
| Mencatat penerimaan/pengiriman barang baru | Role `admin` atau `accountant` |
| Mengubah atau menghapus yang sudah tercatat | **Tidak ada seorang pun** — immutable total, koreksi lewat proses retur, bukan edit langsung |
