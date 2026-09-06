# Saldo Kredit Retur (Return Credits) — Struktur Data

Konsep bisnisnya adalah "kelebihan retur" — kalau barang yang diretur nilainya lebih besar dari sisa tagihan invoice/bill yang ada, kelebihan itu gak boleh bikin tagihan minus, jadi otomatis direklasifikasi jadi saldo kredit resmi. Sisi AR ada di `docs/domain/accounts-receivable.md` bagian "Retur Barang (Credit Note)" > "Saldo Kredit dari Retur", pasangan AP-nya di `docs/domain/accounts-payable.md` bagian "Retur Barang ke Supplier". Detail teknis (SQL, nama fungsi persis) ada di `memory/architecture/data/return-credits-schema.md`.

Tabel ini adalah salah satu dari 4 tabel anak AR/AP yang berbentuk generic (lihat juga `payments-schema.md`, `credit-notes-schema.md`, `deposits-schema.md`) — 1 pasang tabel `return_credits`+`return_credit_refunds` yang menampung kedua arah, dibedakan lewat kolom `type` (`INBOUND` = AR/customer, `OUTBOUND` = AP/supplier).

## Peta Data (ERD) — Ringkasan Semua Tabel

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `return_credits` | Saldo kredit yang lahir otomatis dari kelebihan retur — `INBOUND` = liability ke customer, `OUTBOUND` = asset dari supplier | `counterparties`, `credit_notes` |
| `return_credit_refunds` | Riwayat pencairan tunai atas saldo `return_credits` | `return_credits` |

## Lahirnya Saldo Kredit (dari Retur)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `return_credits` | 1 baris = 1 saldo kredit, lahir dari 1 retur (`credit_notes`) yang excess-nya melebihi sisa tagihan | `counterparties.id`, `credit_notes.id` |

Kolom penting: `type` (`INBOUND`/`OUTBOUND`, ikut arah retur asalnya), `counterparty_id`, `credit_note_id` (retur yang jadi sumbernya), `amount` (nominal kelebihan, bukan seluruh nominal retur). Tabel ini **gak punya `source_ref` sendiri** — dokumen sumbernya ya `credit_notes` yang bersangkutan, karena baris ini murni derivatif otomatis, bukan hasil input user langsung.

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Retur bikin outstanding invoice/bill jadi minus | Tidak ada RPC sendiri — insert inline dari dalam `create_ar_credit_note`/`create_ap_credit_note` (lihat `credit-notes-schema.md`) begitu terdeteksi excess | Insert 1 baris `return_credits` dengan `type` ikut arah retur asalnya | RLS insert (admin/accountant, lewat RPC pemanggil); trigger `return_credits_counterparty_role_guard_inbound`/`_outbound` (customer wajib untuk INBOUND, supplier wajib untuk OUTBOUND); trigger `return_credits_type_matches_credit_note` menolak kalau `type` gak sama dengan `credit_notes.type` milik retur asalnya |
| Perubahan status tagihan asal ikut ter-refresh | Trigger `return_credits_sync_transaction_status` (after insert) | Lookup `transaction_id` lewat `credit_notes` (gak ada FK langsung ke `transactions`), lalu `recompute_transaction_status` | Otomatis, gak butuh aksi user |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Kelebihan retur gak boleh nyangkut jadi outstanding minus — harus otomatis jadi saldo kredit resmi | Logic di dalam `create_ar_credit_note`/`create_ap_credit_note` yang insert `return_credits` begitu terdeteksi excess |
| Saldo kredit AR itu liability ke customer, saldo kredit AP itu asset dari supplier — arahnya harus konsisten sama retur asalnya | Trigger `return_credits_type_matches_credit_note` + guard peran counterparty (`_inbound`/`_outbound`) |
| Saldo kredit yang sudah lahir gak boleh diubah/dihapus manual | Trigger `return_credits_block_edit_delete` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `return_credits.credit_note_id` | banyak-ke-satu | `credit_notes` |
| `return_credits.counterparty_id` | banyak-ke-satu | `counterparties` |
| `return_credits` (lewat `credit_notes.transaction_id`) | tidak langsung, dipakai buat sinkron status | `transactions` |
| `warranty_replacements.credit_note_id` | historis (cuma jalur AR lama, dipakai reducer `return_credit_remaining`) | `credit_notes` → `return_credits` |

Catatan gap yang sengaja dicatat (bukan bug): FK `warranty_replacements.credit_note_id` bisa menunjuk ke `credit_notes` arah mana pun (`INBOUND` atau `OUTBOUND`), tapi yang mencegah baris OUTBOUND kesambung ke situ murni "gak ada RPC yang nulis kolom itu untuk arah OUTBOUND", bukan constraint database — kalau suatu saat ada fitur baru yang menulis ke kolom itu untuk arah OUTBOUND, butuh guard eksplisit baru.

## Pencairan Saldo Kredit (Refund Tunai)

**Peta Data (ERD)**

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `return_credit_refunds` | 1 baris = 1 pencairan tunai (sebagian atau penuh) dari 1 `return_credits` | `return_credits.id` |

Kolom penting: `credit_id`, `amount`, `source_ref` (di sini baru ada dokumen sumbernya sendiri, karena refund adalah aksi yang diinisiasi user).

**Alur Teknis (RPC)**

| Aksi | RPC | Efek | Guard |
|---|---|---|---|
| Cairkan saldo kredit jadi tunai | `refund_return_credit` | `type` dilihat otomatis dari `return_credits` (caller gak perlu kirim). INBOUND: Debit akun saldo kredit (liability) / Kredit Kas. OUTBOUND: Debit Kas / Kredit akun saldo kredit (asset) | Trigger `return_credit_refunds_guard` menolak kalau `amount` melebihi sisa saldo (`return_credit_remaining`); RLS insert admin/accountant |
| Saldo kredit sisa dihitung | Fungsi `return_credit_remaining(credit_id)` | `amount` awal dikurangi total yang sudah dipakai jalur lain (mis. penukaran barang lewat `warranty_replacements`) dan total refund yang sudah dicairkan — dihitung on-the-fly, gak disimpan sebagai kolom | Dipakai bareng oleh trigger guard di atas |

**Aturan Bisnis → RPC**

| Aturan (dari docs/domain) | Dijaga oleh |
|---|---|
| Total saldo kredit yang dicairkan tunai gak boleh melebihi nominal awal saldo itu | Trigger `return_credit_refunds_guard` + fungsi `return_credit_remaining` |
| Arah jurnal refund mengikuti arah saldo kreditnya (liability untuk AR, asset untuk AP) — bukan diinput manual | RPC `refund_return_credit` lookup `type` internal dari `return_credits` |
| Refund yang sudah dicatat gak boleh diubah/dihapus | Trigger `return_credit_refunds_block_edit_delete` |
| Refund cuma disposisi lanjutan — gak menyentuh lagi status tagihan asalnya (yang sudah direklasifikasi keluar sejak saldo kredit lahir) | Sengaja **tidak ada** trigger sync status di `return_credit_refunds` |

**Interaksi Antar Tabel**

| Tabel A | Relasi | Tabel B |
|---|---|---|
| `return_credit_refunds.credit_id` | banyak-ke-satu | `return_credits` |
| `return_credit_refunds.journal_entry_id` | satu-ke-satu | jurnal (modul Journal Entry) |

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat saldo kredit retur & riwayat pencairannya | Semua user yang sudah login |
| Membuat saldo kredit retur baru | Tidak ada jalur langsung — lahir otomatis saat admin/accountant membuat credit note yang excess |
| Mencairkan saldo kredit (refund) | Role `admin` atau `accountant` |
| Mengubah/menghapus baris saldo kredit atau riwayat refund | **Tidak ada seorang pun** — keduanya immutable begitu tercatat |
