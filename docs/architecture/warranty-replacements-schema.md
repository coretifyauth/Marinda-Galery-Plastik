# Penukaran Barang Pasca-Retur (Garansi) — Struktur Data

Konsep bisnisnya ada di `docs/domain/accounts-receivable.md` bagian "Penukaran Barang Pasca-Retur (Garansi)" — customer punya barang cacat dan minta barang pengganti, bukan retur (dapat kredit/diskon). File ini fokus ke bagaimana datanya disimpan dan aturan apa yang dijaga otomatis oleh sistem. Detail teknis (SQL, nama fungsi persis) ada di `memory/architecture/data/warranty-replacements-schema.md`. Ini sisi AR — mirror persis sisi AP-nya ada di `purchase-replacements-schema.md`, dua-duanya tabel fisik terpisah karena beda arah (beda dari `credit_notes`, lihat `credit-notes-schema.md`).

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `warranty_replacements` | Header 1 kejadian penukaran barang (bisa lebih dari 1 kali per invoice) | `transactions` (invoice), `credit_notes` (histori doang), `journal_entries` |
| `warranty_replacement_lines` | Rincian barang & qty yang ditukar per kejadian | `warranty_replacements`, `items` |

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `warranty_replacements` | 1 baris = 1 kejadian penukaran barang. Nunjuk langsung ke invoice, TANPA perlu retur tercatat lebih dulu | `transactions.id` (invoice), `journal_entries.id` |
| `warranty_replacement_lines` | Barang & qty yang ditukar di 1 kejadian | `warranty_replacements`, `items` |

**Struktur (kolom yang penting buat dipahami)**

| Kolom | Isinya | Catatan |
|---|---|---|
| `invoice_id` | Invoice asal barang yang cacat | Rujukan utama — independen dari retur/credit note |
| `credit_note_id` | Opsional, boleh kosong | Cuma terisi di baris historis lama; baris baru selalu kosong |
| `journal_entry_id` | Jurnal Debit HPP / Kredit Persediaan Barang Jadi | Satu-satunya jurnal yang tercipta — Piutang Usaha & Pendapatan sama sekali gak disentuh |
| Kolom pembalikan diskon & penyelesaian saldo kredit retur | Tidak dipakai oleh alur saat ini | Tetap ada di tabel buat baca histori data lama, kejadian baru gak pernah mengisinya (selalu nol/kosong) |
| `qty_replaced`, `total_cost` (di `_lines`) | Qty barang ditukar & nilai HPP-nya | Dihitung dari harga rata-rata berjalan (Weighted Average) saat kejadian, bukan harga historis |

**Kenapa Berdiri Sendiri (Independen dari Retur)**

Penukaran barang gak menempel ke retur — sejalan dengan cara AP menangani kasus serupa (tukar barang ke supplier, lihat `purchase-replacements-schema.md`): customer harus pilih SATU jalan sejak awal — retur (dapat kredit/diskon) ATAU ganti barang, gak bisa dua-duanya buat barang yang sama. Karena pilihan dipisah sejak awal, sistem gak perlu "mengoreksi" apa pun setelahnya — kompensasi ganda dicegah dari akarnya, bukan ditambal belakangan.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Catat penukaran barang | `create_warranty_replacement` | Konsumsi stok barang jadi (Weighted Average) sejumlah qty ditukar, insert header + lines + mutasi stok, bikin 1 jurnal Debit HPP / Kredit Persediaan Barang Jadi | Baris `p_lines` gak boleh kosong; trigger `warranty_replacement_lines_no_over_replace` mencegah qty ditukar melebihi sisa yang belum "diklaim" (lihat aturan bisnis di bawah) |
| Cek sisa qty yang masih bisa diklaim (retur ATAU ganti barang) | Fungsi bantu `sales_returned_qty(invoice_id, item_id)` | Menjumlah qty yang sudah "dipakai" — lintas retur kredit maupun ganti barang — buat 1 item di 1 invoice | Dipakai trigger di atas, bukan dipanggil user langsung |

RPC-nya sederhana — tidak ada parameter yang berhubungan dengan retur (nunjuk credit note, akun kontra-pendapatan, akun piutang, akun saldo kredit retur). RPC cuma butuh: invoice asal, tanggal, referensi dokumen, daftar barang & qty, plus 2 akun (HPP dan Persediaan Barang Jadi).

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Satu barang, satu jalan kompensasi — qty yang sudah diretur gak bisa lagi diganti barang, dan sebaliknya, berlaku dari arah mana pun duluan diajukan | Fungsi `sales_returned_qty` menjumlah klaim lintas kedua jalur (retur kredit via `credit_notes`/`inventory_returns`, dan ganti barang via `warranty_replacement_lines`), dipakai trigger `warranty_replacement_lines_no_over_replace` |
| Ganti barang gak berlaku buat tagihan yang gak pernah punya barang fisik keluar (misal tagihan jasa) | Trigger yang sama menolak (raise exception) kalau item gak ditemukan di catatan barang keluar invoice tersebut |
| Total qty ditukar (dikurangi yang sudah diretur) gak boleh melebihi qty yang benar-benar terjual | Trigger `warranty_replacement_lines_no_over_replace`, dibandingkan ke qty barang keluar asli dikurangi `sales_returned_qty()` |
| Piutang Usaha customer gak boleh tersentuh oleh penukaran barang | RPC cuma bikin 1 jurnal (HPP/Persediaan), gak pernah menyentuh akun piutang |
| Barang pengganti diambil dari stok layak jual, bukan stok barang rusak hasil retur | Barang rusak dari retur gak pernah masuk balik ke `inventory_balances` (langsung jadi beban), jadi otomatis gak ikut kepakai lagi saat konsumsi stok penukaran |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `warranty_replacements.invoice_id` | banyak-ke-satu | `transactions` (invoice) |
| `warranty_replacements.credit_note_id` | banyak-ke-satu, nullable, histori doang | `credit_notes` |
| `warranty_replacements.journal_entry_id` | banyak-ke-satu | `journal_entries` |
| `warranty_replacement_lines.warranty_replacement_id` | banyak-ke-satu | `warranty_replacements` |
| `warranty_replacement_lines.item_id` | banyak-ke-satu | `items` |
| `warranty_replacement_lines` (via `sales_returned_qty`) | dibandingkan dengan | `inventory_return_lines` / `credit_notes` (retur kredit, lihat `credit-notes-schema.md`) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar penukaran barang | Semua user yang sudah login |
| Mencatat penukaran barang baru | Role `admin` atau `accountant` |
| Mengubah/menghapus penukaran barang yang sudah tercatat | **Tidak ada seorang pun** — immutable, sama seperti pola `credit_notes`/`inventory_returns` (kalau salah input, dikoreksi dengan mencatat kejadian baru, bukan mengedit yang lama) |
