# Ganti/Tukar Barang (Replacements) — Struktur Data

Konsep bisnisnya ada di 2 tempat: sisi AR di `docs/domain/accounts-receivable.md` bagian "Penukaran Barang Pasca-Retur (Garansi)" — customer punya barang cacat dan minta barang pengganti, bukan retur (dapat kredit/diskon); sisi AP di `docs/domain/accounts-payable.md` bagian "Retur Barang ke Supplier" (Opsi B — Tukar Barang) — bahan baku yang diterima ternyata rusak dan supplier setuju mengirim barang pengganti, bukan mengurangi utang. File ini fokus ke bagaimana datanya disimpan dan aturan apa yang dijaga otomatis oleh sistem. Detail teknis (SQL, nama fungsi persis) ada di `supabase/migrations/0027_replacements_schema.sql`.

Ini 1 pasang tabel `replacements`+`replacement_lines` yang menampung KEDUA arah, dibedakan lewat kolom `type` (`INBOUND` = AR/garansi, `OUTBOUND` = AP/tukar ke supplier) — pola sama `return_credits`/`payments`/`deposits`/`returns` (lihat `return-credits-schema.md`).

**Migration:** `supabase/migrations/0027_replacements_schema.sql` (2026-09-09) — menggantikan `warranty_replacements` (AR, migration `0021`, sudah di-drop) + `purchase_replacements` (AP, migration `0022`, sudah di-drop). Unifikasi dilakukan setelah dikonfirmasi kedua tabel lama sudah tidak punya baris data (`inventory_movements` di-TRUNCATE total 2026-09-07) dan 5 kolom vestigial `warranty_replacements` (`return_id`, `discount_reversed_amount`, `discount_reversal_journal_entry_id`, `return_credit_settled_amount`, `return_credit_settlement_journal_entry_id`) sudah tidak pernah diisi RPC aktif — kapabilitas "settle saldo kredit retur lewat ganti barang" yang dulu diwakili kolom itu sudah dilarang eksplisit (`docs/domain/accounts-receivable.md` baris 55-58, cuma boleh refund tunai). Riwayat lengkapnya ada di `git log` dan di migration `0021`/`0022` yang masih ada sebagai catatan historis (tidak diedit, sesuai konvensi live-linked project).

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `replacements` | Header 1 kejadian ganti/tukar barang. `type='INBOUND'` = ganti barang garansi ke customer, `type='OUTBOUND'` = tukar barang rusak ke supplier | `transactions`, `journal_entries` |
| `replacement_lines` | Rincian barang & qty yang diganti/ditukar per kejadian | `replacements`, `items` |

## Konsep Inti

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `type` | `INBOUND` (AR/garansi) atau `OUTBOUND` (AP/tukar ke supplier) | Menentukan arah bisnis DAN bentuk jurnal/movement — lihat "Alur Teknis" |
| `transaction_id` | Invoice asal (INBOUND) atau bill asal (OUTBOUND) | Rujukan utama — independen dari retur, TANPA perlu retur tercatat lebih dulu di kedua arah |
| `journal_entry_id` | INBOUND: Debit HPP / Kredit Persediaan Barang Jadi. OUTBOUND: Debit Persediaan / Kredit Persediaan (akun yang sama, net nol) | Satu-satunya jurnal yang tercipta — Piutang/Utang Usaha sama sekali gak disentuh |
| `qty_replaced`, `total_cost` (di `_lines`) | Qty barang diganti/ditukar & nilai HPP/costing-nya | Dihitung dari harga rata-rata berjalan (Weighted Average) saat kejadian, bukan harga historis |

**Kenapa Berdiri Sendiri (Independen dari Retur)**

Kedua arah gak menempel ke retur — customer/supplier harus pilih SATU jalan sejak awal: retur (dapat kredit/kurangi utang) ATAU ganti/tukar barang, gak bisa dua-duanya buat barang yang sama. Karena pilihan dipisah sejak awal, sistem gak perlu "mengoreksi" apa pun setelahnya — kompensasi ganda dicegah dari akarnya, bukan ditambal belakangan.

**Kenapa TIDAK digabung jadi 1 tabel dengan `returns`, tapi TETAP 1 tabel gabungan AR/AP:** `returns` dan `replacements` adalah 2 mekanisme kompensasi yang berbeda bentuk secara fundamental (retur mengurangi tagihan lewat jurnal kontra-pendapatan/beban, replacement gak menyentuh tagihan sama sekali). Sebaliknya, sisi AR dan AP dari `replacements` **sudah identik strukturnya** (jumlah kolom sama, satu-satunya beda dulu — 5 kolom vestigial AR — sudah tidak relevan), jadi digabung lewat `type` seperti pasangan AR/AP lain.

**Kenapa jumlah `inventory_movements` per baris TETAP beda per `type` (bukan disamakan)**

Ini satu-satunya asimetri asli yang dipertahankan, karena mencerminkan kejadian fisik yang genuinely berbeda:

- **`OUTBOUND` (AP) — selalu 2 movement**: barang cacat keluar (dikirim ke supplier) + barang baru masuk (diterima dari supplier). Barang cacat itu memang sudah tercatat sebagai stok aktif milik perusahaan (diterima resmi lewat goods receipt sebelumnya), jadi menukarnya balik ke supplier adalah pengurangan stok riil yang harus dicatat, dan barang baru yang masuk adalah penambahan stok riil juga — biar `qty_on_hand` akurat, walau nilainya net nol.
- **`INBOUND` (AR) — selalu 1 movement**: cuma barang pengganti yang keluar ke customer. Barang cacat customer **TIDAK PERNAH** tercatat sebagai stok milik perusahaan (dia sudah keluar dari `inventory_balances` sejak invoice asli terbit lewat goods issue) — `docs/domain/accounts-receivable.md` baris 101 menegaskan barang rusak dari customer gak pernah masuk balik ke stok aktif lewat jalur mana pun. Jadi gak ada "stok yang harus dikurangi" untuk unit cacat itu.

Memaksakan `INBOUND` ikut pola `OUTBOUND` (2 movement) akan menciptakan movement "masuk" untuk barang yang gak pernah jadi aset perusahaan — merusak akurasi `qty_on_hand`/`avg_cost`.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat ganti/tukar barang | `create_replacement(p_type, p_transaction_id, p_replacement_date, p_source_ref, p_lines, p_debit_account_id, p_credit_account_id)` | 1 jurnal pakai akun yang dikirim caller apa adanya (INBOUND: 2 akun beda — HPP & Persediaan Barang Jadi; OUTBOUND: 1 akun dikirim dua kali — Persediaan). Loop tiap baris: **selalu** `consume_weighted_average` + 1 movement keluar; **cuma kalau `OUTBOUND`**, tambahan recompute `inventory_balances` (avg_cost) + 1 movement masuk | `p_lines` gak boleh kosong; `p_type` harus `INBOUND`/`OUTBOUND`; trigger `replacement_lines_no_over_claim_trigger` mencegah qty melebihi sisa yang belum "diklaim" |
| Cek sisa qty yang masih bisa diklaim (retur ATAU ganti/tukar barang) | `sales_returned_qty(invoice_id, item_id)` (INBOUND) / `purchase_returned_qty(bill_id, item_id)` (OUTBOUND) | Menjumlah qty yang sudah "dipakai" — lintas retur (`return_lines`) maupun ganti/tukar barang (`replacement_lines` filter `type` yang sesuai) — buat 1 item di 1 transaksi | Dipakai trigger guard, bukan dipanggil user langsung |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Satu barang, satu jalan kompensasi — qty yang sudah diretur gak bisa lagi diganti/ditukar, dan sebaliknya, berlaku dari arah mana pun duluan diajukan | `sales_returned_qty`/`purchase_returned_qty` menjumlah klaim lintas kedua jalur, dipakai trigger `replacement_lines_no_over_claim_trigger` |
| Ganti/tukar barang gak berlaku buat transaksi yang gak pernah punya barang fisik keluar/masuk (mis. jasa, financial-only) | Trigger yang sama menolak (raise exception) kalau item/goods note gak ditemukan |
| Total qty diganti/ditukar (dikurangi yang sudah diretur) gak boleh melebihi qty yang benar-benar terjual/diterima | Trigger `replacement_lines_no_over_claim_trigger`, dibandingkan ke `goods_note_lines.qty` (arah lawan dari `type`) |
| Piutang/Utang Usaha gak boleh tersentuh oleh ganti/tukar barang, di status bayar apa pun | RPC cuma bikin 1 jurnal (HPP/Persediaan atau Persediaan/Persediaan), gak pernah menyentuh akun piutang/utang |
| Barang pengganti diambil dari stok layak jual, bukan stok barang rusak hasil retur | Barang rusak dari retur gak pernah masuk balik ke `inventory_balances` (langsung jadi beban), jadi otomatis gak ikut kepakai lagi saat konsumsi stok replacement |
| Barang rusak yang supplier tolak kompensasi sama sekali (OUTBOUND) ditangani lewat Stock Opname generic, bukan mekanisme ini | Tidak ada tabel/RPC khusus untuk jalur ini — lihat `stock-opname-schema.md` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `replacements.transaction_id` | banyak-ke-satu | `transactions` (invoice atau bill, tergantung `type`) |
| `replacements.journal_entry_id` | banyak-ke-satu | `journal_entries` |
| `replacement_lines.replacement_id` | banyak-ke-satu | `replacements` |
| `replacement_lines.item_id` | banyak-ke-satu | `items` |
| `replacement_lines` (via `sales_returned_qty`/`purchase_returned_qty`) | dibandingkan dengan | `return_lines`/`returns` (lihat `returns-schema.md`) dan `goods_note_lines` (lihat `goods-notes-schema.md`) |
| `inventory_movements.replacement_line_id` | banyak-ke-satu (komposit dengan `item_id`) | `replacement_lines` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar ganti/tukar barang | Semua user yang sudah login |
| Mencatat ganti/tukar barang baru | Role `admin` atau `accountant` |
| Mengubah/menghapus baris yang sudah tercatat | **Tidak ada seorang pun** — immutable, kalau salah input dikoreksi lewat kejadian baru, bukan mengedit yang lama |
