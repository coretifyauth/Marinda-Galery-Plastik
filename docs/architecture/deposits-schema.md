# Uang Muka / DP (Deposits) — Struktur Data

Konsep bisnisnya adalah uang muka (DP) — uang yang berpindah tangan sebelum tagihannya sendiri ada. Sisi AR (DP diterima dari customer) ada di `docs/domain/accounts-receivable.md` bagian "Uang Muka / DP (Deposit)", sisi AP (DP dibayar ke supplier) di `docs/domain/accounts-payable.md` bagian "Uang Muka / DP ke Supplier". Detail teknis (SQL, nama fungsi persis) ada di `memory/architecture/data/deposits-schema.md`.

Sama seperti `return-credits-schema.md` dan `returns-schema.md`, ini bagian dari tabel anak AR/AP yang generic — 4 tabel (`deposits` + `deposit_applications`/`deposit_refunds`/`deposit_forfeitures`) yang menampung kedua arah, dibedakan lewat kolom `type` (`OUTBOUND` = DP dari customer/liability, `INBOUND` = DP ke supplier/asset). Beda dari `returns` (RPC tetap 2 fungsi karena logic beda bentuk), di sini ke-4 operasi (create/apply/refund/forfeit) logic-nya near-exact mirror kedua arah — cuma akun & arah debit/kredit ketuker — jadi RPC-nya juga 1 fungsi per operasi untuk kedua arah.

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `deposits` | Saldo DP itu sendiri — `OUTBOUND` diterima dari customer (liability), `INBOUND` dibayar ke supplier (asset). Punya kolom cache `remaining`/`status` | `counterparties` |
| `deposit_applications` | DP yang diterapkan (dipotongkan) ke sebuah invoice/bill | `deposits`, `transactions` |
| `deposit_refunds` | DP yang dicairkan/dikembalikan tunai | `deposits` |
| `deposit_forfeitures` | DP yang hangus (gak dibalikin) | `deposits` |

## Pembuatan DP (`create_deposit`)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `deposits` | 1 baris = 1 DP diterima/dibayar, belum nyentuh invoice/bill apa pun | `counterparties.id` |

Kolom penting: `type` (`INBOUND`/`OUTBOUND`), `counterparty_id`, `amount`, `remaining` (kolom asli, bukan dihitung ulang tiap query — diisi otomatis `= amount` saat insert, lalu di-update tiap ada penyelesaian), `status` (`belum_dipakai` / `sebagian` / `selesai`).

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Terima DP dari customer / bayar DP ke supplier | `create_deposit` | OUTBOUND: Debit Kas / Kredit akun DP (liability). INBOUND: Debit akun DP (asset) / Kredit Kas. Insert 1 baris `deposits`, `remaining` otomatis `= amount` | Trigger `deposits_counterparty_role_guard_inbound`/`_outbound` (supplier wajib untuk INBOUND, customer wajib untuk OUTBOUND); RLS insert admin/accountant |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| DP gak boleh langsung diakui sebagai Pendapatan/Beban atau pengurang Piutang/Utang saat diterima/dibayar — wajib lewat akun DP (liability/asset) dulu | RPC `create_deposit` cuma menyentuh akun Kas dan akun DP, gak pernah akun Pendapatan/Beban/Piutang/Utang di titik ini |
| DP yang sudah dicatat gak boleh diubah/dihapus, kecuali status penyelesaiannya (yang memang berubah otomatis) | Trigger `deposits_block_edit_delete_or_sync` — kolom bisnis asli (`amount`, `type`, dst) immutable, `remaining`/`status` boleh diubah cuma lewat trigger recompute |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `deposits.counterparty_id` | banyak-ke-satu | `counterparties` |
| `deposits.journal_entry_id` | satu-ke-satu | jurnal (modul Journal Entry) |

## Penerapan DP ke Transaksi (`apply_deposit`)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `deposit_applications` | 1 baris = 1 kali DP dipotongkan ke 1 invoice/bill | `deposits.id`, `transactions.id` (lihat `transactions-schema.md`) |

Kolom penting: `deposit_id`, `transaction_id`, `amount`. Tabel ini **gak punya kolom `type` sendiri** (beda dari `payments`/`returns`) — konsistensi arah dicek langsung di fungsi guard lewat 2 lookup, bukan lewat kolom denormalisasi.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Terapkan DP ke invoice/bill yang sudah terbit | `apply_deposit` | OUTBOUND: Debit akun DP (liability) / Kredit Piutang Usaha. INBOUND: Debit Utang Usaha / Kredit akun DP (asset). Insert 1 baris `deposit_applications`, mengurangi sisa tagihan invoice/bill itu | Fungsi guard `deposit_applications_guard`: (1) `amount` gak boleh melebihi sisa DP, (2) arah DP harus sama dengan arah transaksi tujuan, (3) DP dan transaksi harus milik counterparty yang sama, (4) transaksi tujuan belum dibatalkan, (5) `amount` gak boleh melebihi sisa outstanding transaksi tujuan |
| Status DP & status transaksi ikut ter-refresh | Trigger `deposit_applications_sync_deposit_status` (after insert) | `recompute_deposit_status(deposit_id)` + `recompute_transaction_status(transaction_id)` | Otomatis |
| Invoice/bill yang DP-nya sudah diterapkan dibatalkan | Bagian dari `cancel_ar_invoice`/`cancel_ap_bill` (lihat `transactions-schema.md`) | Penerapan DP ikut otomatis dibalik — DP balik jadi belum dipakai | Loop unwind atas `deposit_applications` di dalam RPC pembatalan |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| DP yang diterapkan gak boleh melebihi sisa DP yang tersedia | Fungsi guard, cek terhadap `deposit_remaining(deposit_id)` |
| DP cuma bisa diterapkan ke transaksi milik counterparty & arah yang sama | Fungsi guard, cek `type` dan `counterparty_id` DP vs transaksi |
| Penerapan DP gak boleh melebihi sisa outstanding transaksi tujuan | Fungsi guard, cek `ar_invoice_remaining`/`ap_bill_remaining` |
| Kalau invoice/bill yang DP-nya sudah diterapkan dibatalkan, penerapan DP itu wajib ikut dibalik | Loop unwind di dalam `cancel_ar_invoice`/`cancel_ap_bill` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `deposit_applications.deposit_id` | banyak-ke-satu | `deposits` |
| `deposit_applications.transaction_id` | banyak-ke-satu | `transactions` |

## Refund & Hangus (`refund_deposit` / `forfeit_deposit`)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `deposit_refunds` | DP yang dicairkan tunai kembali ke pemiliknya | `deposits.id` |
| `deposit_forfeitures` | DP yang hangus (gak dibalikin) | `deposits.id` |

Struktur kedua tabel identik dari awal — gak ada kolom yang cuma relevan 1 arah, jadi gak butuh kolom `type`, murni join lewat `deposit_id`.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Cairkan DP jadi tunai (refund) | `refund_deposit` | OUTBOUND: Debit akun DP (liability) / Kredit Kas. INBOUND: Debit Kas / Kredit akun DP (asset). Gak ada dampak Laba Rugi | Trigger guard: `amount` gak boleh melebihi sisa DP |
| DP dinyatakan hangus (forfeit) | `forfeit_deposit` | OUTBOUND: Debit akun DP (liability) / Kredit Pendapatan Lain-lain. INBOUND: Debit Beban Kerugian Uang Muka / Kredit akun DP (asset). Ada dampak Laba Rugi | Trigger guard: `amount` gak boleh melebihi sisa DP |
| Status DP ikut ter-refresh | Trigger sync status masing-masing (after insert) | `recompute_deposit_status(deposit_id)` — **tidak** menyentuh status transaksi (beda dari `apply_deposit`) | Otomatis |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| DP hangus dicatat ke Pendapatan Lain-lain (AR) / Beban Kerugian Uang Muka (AP) — bukan akun Pendapatan/Beban Penjualan biasa | RPC `forfeit_deposit` selalu pakai akun offset yang eksplisit dikirim caller, terpisah dari akun Pendapatan Penjualan |
| Refund DP gak boleh dicatat lewat jalur hangus (atau sebaliknya) — dampak Laba Rugi beda | 2 RPC terpisah (`refund_deposit` vs `forfeit_deposit`), masing-masing jurnal ke akun yang beda |
| Total penyelesaian 1 DP (diterapkan + refund + hangus) gak boleh melebihi nilai DP awal | Ketiga trigger guard (`apply`/`refund`/`forfeit`) semua cek terhadap fungsi `deposit_remaining` yang sama, yang menghitung sisa setelah dikurangi ketiga jalur sekaligus |
| Bagian DP yang sudah diterapkan gak bisa direfund/dihanguskan lagi | `deposit_remaining` mengurangi total `deposit_applications` juga, bukan cuma refund/forfeiture |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `deposit_refunds.deposit_id` | banyak-ke-satu | `deposits` |
| `deposit_forfeitures.deposit_id` | banyak-ke-satu | `deposits` |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat DP dan seluruh riwayat penyelesaiannya (terapkan/refund/hangus) | Semua user yang sudah login |
| Mencatat DP baru (terima dari customer / bayar ke supplier) | Role `admin` atau `accountant` |
| Menerapkan DP ke invoice/bill | Role `admin` atau `accountant` |
| Mencairkan (refund) atau menghanguskan (forfeit) DP | Role `admin` atau `accountant` |
| Mengubah/menghapus baris DP, penerapan, refund, atau forfeiture yang sudah tercatat | **Tidak ada seorang pun** — semua immutable, kecuali `remaining`/`status` pada `deposits` yang memang cache otomatis |
