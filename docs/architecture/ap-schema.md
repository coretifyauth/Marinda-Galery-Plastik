# Accounts Payable — Struktur Data & Teknis

Fase 4. Konsep bisnisnya ada di `docs/domain/accounts-payable.md`. Detail teknis penuh (DDL/trigger): `memory/architecture/data/ap-schema.md`. Strukturnya cerminan persis dari Accounts Receivable (`docs/architecture/ar-schema.md`), arah kebalik — di sini kita yang berutang, bukan piutang.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `suppliers` | Master data pemasok (nama, kontak, termin pembayaran) | — |
| `ap_bills` | Tagihan yang diterima dari pemasok | `suppliers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ap_payments` | Pembayaran yang dikirim ke pemasok — selalu menunjuk 1 bill spesifik, boleh cicil, gak boleh kelebihan bayar | `suppliers`, `ap_bills` (banyak-ke-satu), dan ke transaksi jurnal yang otomatis dibuat |
| `ap_credit_notes` | Retur barang ke pemasok, jalur "kurangi utang" (Opsi A) | `ap_bills`, dan ke transaksi jurnal yang otomatis dibuat |
| `purchase_return_lines` | Rincian barang yang diretur per item (cuma kalau bill-nya diterima lewat penerimaan barang bertahap) | `ap_credit_notes` |
| `purchase_replacements` + `purchase_replacement_lines` | Tukar barang rusak dengan barang baik dari pemasok, jalur "tukar barang" (Opsi B) — berdiri sendiri, tidak menyambung ke `ap_credit_notes` | `ap_bills` |
| `purchase_writeoffs` + `purchase_writeoff_lines` | Barang rusak yang pemasok tolak kompensasi sama sekali, jalur "tulis-jadi-beban" (Opsi C) — berdiri sendiri, gak menyambung ke `ap_credit_notes`, Utang Usaha gak pernah kesentuh | `ap_bills` |
| `ap_return_credits` | Saldo "Piutang Retur Pemasok" — muncul otomatis kalau Opsi A dipakai pada bill yang sudah lunas | `ap_credit_notes` |
| `ap_return_credit_refunds` | Saldo di atas dicairkan tunai (satu-satunya disposisi — "dipakai motong bill lain" sudah dicabut, bukan fondasi AP) | `ap_return_credits` |
| `ap_deposits` | Uang muka yang kita bayar ke pemasok sebelum ada bill — asset "Uang Muka Pembelian" (kebalikan AR: di AR itu liability, di sini asset karena pemasok yang "berutang" balik ke kita) | `suppliers`, dan ke transaksi jurnal yang otomatis dibuat |
| `ap_deposit_applications` | DP di atas diterapkan ke bill yang sudah diterbitkan | `ap_deposits`, `ap_bills` |
| `ap_deposit_refunds` | DP dicairkan tunai kembali (pemasok yang mutuskan, bukan kita) — tidak berdampak Laba Rugi | `ap_deposits` |
| `ap_deposit_forfeitures` | DP dianggap hangus (pemasok tidak mau/tidak bisa balikin) — jadi Beban Kerugian Uang Muka | `ap_deposits` |
| `ap_bill_debit_lines` | Rincian baris debit (kategori beban/persediaan + PPN) 1 bill, kalau lebih dari 1 kategori | `ap_bills` (banyak-ke-satu) |
| `ap_bill_expense_categories` | Katalog kategori beban/persediaan tambahan yang bisa dipilih staf saat bikin bill — master data, disiapkan admin | `accounts` |
| `tax_settings` | Pengaturan PPN (tarif, status aktif, akun Keluaran/Masukan) — 1 baris untuk seluruh sistem, dipakai bareng AR/POS, didefinisikan penuh di `docs/architecture/ar-schema.md` | `accounts` |

Satu perbedaan penting dari AR: kolom termin pembayaran di sini artinya kebalik — di Piutang, kita yang menetapkan termin ke pelanggan; di Utang, pemasok yang menetapkan termin ke kita. Kolom & cara kerjanya identik, cuma makna bisnisnya kebalik.

## Konsep Inti

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `suppliers` | Master data pemasok | — |
| `ap_bills` | Utang timbul | `suppliers`, transaksi jurnal |
| `ap_payments` | Utang berkurang | `suppliers`, `ap_bills`, transaksi jurnal |

**Struktur `ap_bills`**

| Kolom | Isinya | Catatan |
|---|---|---|
| pemasok | Ke siapa kita berutang | |
| tanggal bill, jatuh tempo | Kapan diterima, kapan harus dibayar | Jatuh tempo dihitung sekali dari termin pemasok **saat bill dicatat**, lalu disimpan permanen — kalau termin pemasok berubah belakangan, bill lama tidak ikut berubah |
| jumlah | Nilai tagihan | |
| akun debit | Persediaan atau Beban, tergantung jenis pembelian | Dipilih manual tiap bill dibuat — beda dari invoice AR yang sisi debitnya selalu tetap (Piutang Usaha). Bisa lebih dari 1 kategori sekaligus dalam 1 nota — lihat bagian "Kategori Campur & PPN" di bawah |
| status (lunas/sebagian/belum/dibatalkan) | — | **Tidak disimpan**, selalu dihitung ulang dari total pembayaran yang sudah dialokasikan |

Kenapa cukup satu pembayaran nunjuk satu bill (bukan tabel jembatan banyak-ke-banyak) — sempat ada desain yang mengizinkan 1 pembayaran dipecah ke banyak bill sekaligus ("bayar gabungan"), dicabut demi selaras kebijakan penagihan AR: pembayaran taat ke 1 obligasi spesifik. Tapi **cicilan boleh** — 1 bill bisa punya banyak baris pembayaran dari waktu ke waktu.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Buat bill | `create_ap_bill` | Menghitung `due_date`, memanggil `create_journal_entry` (Debit akun yang dipilih — Persediaan/Beban, Kredit Utang Usaha), insert `ap_bills` menunjuk `journal_entry_id` | Akun debit diterima sebagai parameter, gak di-hardcode — beda dari `create_ar_invoice` yang akunnya fixed |
| Catat pembayaran | `record_ap_payment` | Memanggil `create_journal_entry` (Debit Utang Usaha, Kredit Kas/Bank), insert `ap_payments` menunjuk 1 `bill_id` | `p_amount > ap_bill_remaining(bill_id)` → `raise exception` (overpay ditolak, cicil lolos) |
| Batalkan bill | `cancel_ap_bill` | Memanggil `reverse_journal_entry` pakai akun sama persis; bill asli tidak diedit | Ditolak kalau ada `ap_payments` atau `ap_credit_notes`; auto-unwind `ap_deposit_applications` aktif (lihat submodule "Uang Muka / DP ke Supplier") |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Pembayaran boleh kurang dari sisa tagihan, gak boleh lebih | `record_ap_payment` — cek `p_amount > ap_bill_remaining(bill_id)` |
| Bill/payment gak boleh diedit/dihapus | RLS tanpa policy `update`/`delete` + trigger `block_edit_delete` |
| Bill cuma bisa dibatalkan kalau belum ada pembayaran/retur | `cancel_ap_bill` — cek `count(*)` dari `ap_payments` dan `ap_credit_notes` |
| `due_date` snapshot, gak retroaktif ikut perubahan termin | `create_ap_bill` — dihitung sekali dari termin supplier saat insert, disimpan sebagai kolom biasa |
| Status bill derived, bukan kolom manual | Dihitung dari `SUM(ap_payments.amount)` vs `ap_bills.amount`, ditambah cek reversal di `journal_entries` |
| Gak ada bayar gabungan lintas bill | `record_ap_payment` — parameter `p_bill_id` tunggal, gak ada array alokasi |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `ap_bills` | banyak-ke-satu | `suppliers` |
| `ap_payments` | banyak-ke-satu | `ap_bills` |
| `ap_bills` / `ap_payments` | satu-ke-satu (`journal_entry_id`, `not null`) | `journal_entries` |

## Retur Barang ke Supplier

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `ap_credit_notes` | Retur barang, Opsi A ("kurangi utang") | `ap_bills`, dan ke transaksi jurnal yang otomatis dibuat |
| `purchase_return_lines` | Rincian item retur, cuma jalur full (bill lewat penerimaan barang) | `ap_credit_notes` |
| `purchase_replacements` + `purchase_replacement_lines` | Tukar barang, Opsi B — berdiri sendiri, gak menyambung ke `ap_credit_notes` | `ap_bills` |
| `purchase_writeoffs` + `purchase_writeoff_lines` | Tulis-jadi-beban, Opsi C — berdiri sendiri, gak menyambung ke `ap_credit_notes`, Utang Usaha gak pernah kesentuh | `ap_bills` |
| `ap_return_credits` | Saldo "Piutang Retur Supplier" — lahir otomatis kalau Opsi A dipakai pada bill yang sudah lunas | `suppliers`, `ap_credit_notes` (sumbernya) |
| `ap_return_credit_refunds` | Saldo di atas dicairkan tunai — satu-satunya disposisi | `ap_return_credits` |

Fitur ini cuma menangani item dengan metode costing Rata-Rata Tertimbang (satu-satunya metode yang ada sekarang, FIFO sudah dihapus total). Sengaja gak ada batas waktu retur (umur bill vs tanggal retur) — keputusan final, mirror AR yang juga sudah mencabut validasi serupa total. Barang rusak yang sama sekali gak dapat kompensasi dari supplier (gak dikurangin utang, gak diganti barang) ditangani Opsi C (`purchase_writeoffs`) — kerugian murni (Beban Kerugian Barang Rusak), bukan retur.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Retur, Opsi A (kurangi utang) | `create_ap_credit_note` | Kalau financial-only: 1 jurnal (Debit Utang Usaha, Kredit Persediaan Bahan Baku). Kalau full (bill lewat penerimaan barang): konsumsi stok dulu lewat fungsi Rata-Rata Tertimbang buat dapetin nilai cost fisik, baru jurnal + insert `ap_credit_notes` + `purchase_return_lines` | Trigger no-over-return (total retur ≤ nilai bill, independen status bayar) |
| Deteksi & cairkan excess jadi Piutang Retur Supplier | `create_ap_credit_note` (lanjutan aksi di atas, 1 pemanggilan) | Kalau sisa outstanding sebelum retur ini udah minus/kurang dari nominal retur, bagian excess-nya dijurnal ulang (Debit Piutang Retur Supplier, Kredit Utang Usaha) + insert `ap_return_credits` | Parameter akun asset wajib diisi kalau ada excess |
| Retur, Opsi B (tukar barang) | `create_purchase_replacement` | Konsumsi barang rusak + terima barang baru pakai harga rata-rata yang sama (net nol ke nilai Persediaan); insert `purchase_replacements` + `purchase_replacement_lines` | Guard qty gabungan (baris di bawah); Utang Usaha gak pernah disentuh |
| Retur, Opsi C (tulis-jadi-beban) | `create_purchase_writeoff` | Konsumsi barang rusak lewat fungsi Rata-Rata Tertimbang, jurnal Debit Beban Kerugian Barang Rusak / Kredit Persediaan Bahan Baku (BUKAN net-nol seperti Opsi B); insert `purchase_writeoffs` + `purchase_writeoff_lines` | Guard qty gabungan (baris di bawah); Utang Usaha gak pernah disentuh |
| Guard qty gabungan Opsi A + B + C | Trigger di `purchase_return_lines`, `purchase_replacement_lines`, dan `purchase_writeoff_lines` | — | Total qty retur (Opsi A) + total qty tukar (Opsi B) + total qty tulis-jadi-beban (Opsi C) per item per bill ≤ qty yang diterima di bill itu |
| Refund tunai Piutang Retur Supplier | `refund_ap_return_credit` | Jurnal Debit Kas/Bank, Kredit Piutang Retur Supplier; insert `ap_return_credit_refunds` | `amount` melebihi sisa saldo → tolak |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Opsi A, Opsi B, dan Opsi C saling eksklusif per porsi barang yang sama | Keputusan manual orang yang input — `create_ap_credit_note`, `create_purchase_replacement`, `create_purchase_writeoff` adalah 3 RPC independen, gak saling memanggil |
| Total qty retur (A) + tukar (B) + tulis-jadi-beban (C) per item per bill ≤ qty diterima | Trigger guard qty gabungan, jumlahin `purchase_return_lines` + `purchase_replacement_lines` + `purchase_writeoff_lines` — batasnya di level fisik, bukan per-mekanisme, jadi 1 bill boleh dipecah campuran antar opsi |
| Excess dari Opsi A pada bill lunas otomatis jadi saldo resmi | `create_ap_credit_note` — bagian yang melebihi sisa outstanding sebelum retur ini, bukan seluruh nominal retur |
| Saldo Piutang Retur Supplier cuma bisa dicairkan tunai | Cuma 1 RPC yang bisa mengurangi saldo ini: `refund_ap_return_credit` |
| Retur gak boleh masuk periode tertutup | Reuse aturan umum block-retroactive-period dari General Ledger |
| Retur gak boleh ngelebihin nilai bill (Opsi A) | Trigger no-over-return, cap ke nilai bill (independen dari status bayar) |
| Barang rusak yang gak dapat kompensasi sama sekali gak boleh lewat jalur Opsi A | Opsi C (`create_purchase_writeoff`) — gak nyentuh Utang Usaha sama sekali, beda dari Opsi A yang selalu mengurangi utang |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `ap_credit_notes` | banyak-ke-satu | `ap_bills` |
| `purchase_return_lines` | banyak-ke-satu | `ap_credit_notes` |
| `purchase_replacements` | banyak-ke-satu | `ap_bills` (langsung, tanpa lewat `ap_credit_notes`) |
| `purchase_writeoffs` | banyak-ke-satu | `ap_bills` (langsung, tanpa lewat `ap_credit_notes`) |
| `ap_return_credits` | satu-ke-satu | `ap_credit_notes` (sumbernya) |
| `ap_return_credits` | banyak-ke-satu | `suppliers` |
| `ap_return_credit_refunds` | banyak-ke-satu | `ap_return_credits` |

## Uang Muka / DP ke Supplier

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `ap_deposits` | Uang muka dibayar ke pemasok sebelum ada bill | `suppliers`, dan ke transaksi jurnal (Uang Muka Pembelian → Kas) |
| `ap_deposit_applications` | DP diterapkan ke bill yang sudah diterbitkan | Menghubungkan `ap_deposits` ↔ `ap_bills` |
| `ap_deposit_refunds` | DP dicairkan tunai kembali — pemasok yang mutuskan, tidak berdampak Laba Rugi | `ap_deposits` |
| `ap_deposit_forfeitures` | DP dianggap hangus — jadi Beban Kerugian Uang Muka | `ap_deposits` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Bayar DP | `create_ap_deposit` | Jurnal Debit Uang Muka Pembelian, Kredit Kas/Bank; insert `ap_deposits` | — |
| Terapkan ke bill | `apply_ap_deposit` | Jurnal Debit Utang Usaha, Kredit Uang Muka Pembelian; insert `ap_deposit_applications` | `amount` melebihi sisa DP → tolak; bill target harus supplier sama & belum dibatalkan |
| Refund tunai | `refund_ap_deposit` | Jurnal Debit Kas/Bank, Kredit Uang Muka Pembelian; insert `ap_deposit_refunds` | `amount` melebihi sisa DP → tolak |
| Hanguskan | `forfeit_ap_deposit` | Jurnal Debit Beban Kerugian Uang Muka, Kredit Uang Muka Pembelian; insert `ap_deposit_forfeitures` | `amount` melebihi sisa DP → tolak |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| DP gak boleh langsung diakui Beban/pengurang Utang Usaha saat dibayar | `create_ap_deposit` — jurnal selalu ke akun Uang Muka Pembelian (asset), bukan Beban/Utang Usaha |
| Total penyelesaian DP (diterapkan + refund + hangus) ≤ nilai DP awal | Fungsi terpusat sisa DP, dipanggil ketiga guard |
| Bill yang DP-nya diterapkan dibatalkan → penerapan DP ikut dibalik | `cancel_ap_bill` — loop `ap_deposit_applications` aktif milik bill itu |
| Outstanding bill ikut ngurangin DP aktif | Fungsi sisa outstanding bill memasukkan `ap_deposit_applications` sebagai reducer |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `ap_deposits` | banyak-ke-satu | `suppliers` |
| `ap_deposit_applications` | menghubungkan | `ap_deposits` ↔ `ap_bills` |
| `ap_deposit_refunds` / `ap_deposit_forfeitures` | banyak-ke-satu | `ap_deposits` |

## Kategori Campur & PPN

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `ap_bill_debit_lines` | Rincian baris debit (kategori beban/persediaan + PPN) 1 bill | `ap_bills` (banyak-ke-satu) |
| `ap_bill_expense_categories` | Katalog kategori beban/persediaan tambahan — master data | `accounts` |
| `tax_settings` | Pengaturan PPN, sama tabel dengan AR/POS (`docs/architecture/ar-schema.md`) | `accounts` |

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Bikin bill dengan >1 kategori debit | `create_ap_bill` (`p_debit_lines` array) | 1 baris jurnal debit per kategori, insert `ap_bill_debit_lines` per baris | Minimal 1 baris kategori |
| Bikin bill dengan PPN Masukan | `create_ap_bill` (`p_apply_tax=true`) | Tambahan 1 baris debit PPN Masukan, ditambahkan ke Utang Usaha | Ditolak kalau `tax_settings.is_active=false` atau akun PPN Masukan belum diset |

**Aturan Bisnis → RPC**

| Aturan | Dijaga oleh |
|---|---|
| Kategori tambahan dipilih dari katalog, bukan akun bebas | Diselesaikan di UI (dropdown `ap_bill_expense_categories`) |
| PPN gak boleh diketik manual | `create_ap_bill` menghitung sendiri dari `tax_settings` |
| Penerimaan barang dari PO (3-Way Matching) JUGA dapat kategori campur & PPN | `create_goods_receipt` diperluas terima kategori tambahan & PPN, mirror `create_ap_bill` — lihat `docs/architecture/inventory-schema.md` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `ap_bill_debit_lines` | banyak-ke-satu | `ap_bills` |
| `ap_bill_expense_categories` | referensi (dipakai UI, bukan FK langsung) | `ap_bill_debit_lines` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat pemasok, bill, pembayaran, uang muka | Semua user yang sudah login |
| Menambah pemasok baru, mengubah data pemasok | Role `admin` atau `accountant` |
| Membuat bill, mencatat pembayaran, mencatat retur/tukar barang, mencatat/menerapkan/menghanguskan uang muka, refund saldo Piutang Retur Supplier | Role `admin` atau `accountant` |
| Mengedit atau menghapus bill/pembayaran/retur/uang muka | **Tidak ada seorang pun** — hanya pembatalan lewat reversing entry yang diizinkan |
| Menghapus data pemasok secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan |
| Menambah/menonaktifkan kategori beban tambahan, mengubah Pengaturan Pajak | Role `admin` |
