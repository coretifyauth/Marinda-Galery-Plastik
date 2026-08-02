# AR — Piutang Tak Tertagih (Bad Debt Write-off)

**Modul asal:** Accounts Receivable (Fase 3). **Status:** Ditunda.

## Kasus

Kalau piutang customer bener-bener macet (gak akan pernah dibayar — misal warungnya tutup usaha), penjual mengakui itu sebagai **kerugian**, dihapusbukukan lewat jurnal: **Debit Beban Piutang Tak Tertagih, Kredit Piutang Usaha**.

## Kenapa beda dari `cancel_ar_invoice`

`cancel_ar_invoice` (`memory/architecture/data/ar-schema.md`) itu buat "invoice-nya emang salah dari awal" (data-entry error) — hasilnya piutang dianggap "gak pernah ada". Bad debt write-off itu beda: **invoice-nya bener, transaksinya bener terjadi, cuma customernya emang gak akan bisa bayar**. Ini kejadian bisnis nyata (kerugian), bukan koreksi kesalahan — butuh akun baru (`Beban Piutang Tak Tertagih`, kategori expense) yang belum ada di `chart-of-accounts.md`, dan RPC terpisah dari `cancel_ar_invoice` (gak boleh reuse `reverse_journal_entry` yang narik balik ke Pendapatan — bad debt gak boleh ngurangin Pendapatan yang emang udah kejadian, cuma ngakuin piutangnya hilang sebagai beban baru).

## Kenapa ditunda

Belum ada kejadian ini di cerita CV Roti Barokah — 3 warung langganan semuanya masih aktif. Level tindakan ke-4 (paling ekstrem) dari 4 tindakan penjual ke piutang telat, biasanya jarang kejadian buat UMKM sekelas Bu Nur kecuali customer beneran tutup usaha.

## Kapan perlu digarap

Begitu ada skenario customer yang piutangnya dianggap gak akan pernah tertagih di cerita, atau kalau modul Financial Reports (Fase 7) butuh nampilin provisi piutang tak tertagih di Neraca.

## Referensi

- Percakapan desain AR (konteks bisnis piutang telat, 4 tindakan penjual)
- [ar-credit-hold.md](ar-credit-hold.md)
