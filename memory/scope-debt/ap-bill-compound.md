# AP — Bill Kepisah Kategori (Compound Debit)

**Modul asal:** Accounts Payable (Fase 4, masih tahap desain konsep). **Status:** Ditunda.

## Kasus

1 nota supplier bisa isinya campuran kategori — misal Rp750.000 tepung (masuk **Persediaan**, asset) + Rp50.000 ongkos kirim (langsung **Beban**). Ini compound entry (mirip contoh #5 di `docs/domain/general-ledger.md`: bayar cicilan pokok+bunga, 3 baris dalam 1 entry).

## Kenapa ditunda

Rencana `create_ap_bill` (mirror `create_ar_invoice`) didesain nerima **1 akun debit tetap** per panggilan (parameter tunggal, bukan array baris) — sama kayak `create_ar_invoice` yang nerima `p_receivable_account_id` tunggal. Kalau bill-nya kepisah 2+ kategori, RPC ini gak nampung — user kepaksa bikin 2 bill terpisah (padahal secara dokumen fisik itu 1 nota), atau harus insert manual ke `journal_entries`/`journal_lines` lewat `create_journal_entry` generik (bypass `ap_bills`, kehilangan tracking due_date/status AR-style).

## Opsi desain (belum diputuskan)

- `create_ap_bill` nerima `p_lines jsonb` (array baris debit, mirror `create_journal_entry`) — lebih fleksibel, tapi bill jadi punya N kategori debit vs 1 kredit Utang Usaha.
- Atau tetap 1 akun debit per bill, transaksi campuran dipecah jadi 2 bill dengan `source_ref` yang sama (nota fisiknya 1, tapi 2 baris "bill" logis) — lebih simpel, tapi kurang presisi ke dokumen sumber.

## Kapan perlu digarap

Pas mulai desain schema AP beneran (`ap-schema.md` belum ditulis) — ini keputusan yang nentuin bentuk RPC dari awal, bukan tambahan belakangan kayak retur/DP.

## Referensi

- Percakapan desain AP (kasus 8)
- `docs/domain/general-ledger.md` (compound entry, transaksi #5)
