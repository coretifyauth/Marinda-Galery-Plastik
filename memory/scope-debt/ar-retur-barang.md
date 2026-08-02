# AR — Retur Barang (Credit Note)

**Modul asal:** Accounts Receivable (Fase 3). **Status:** Ditunda.

## Kasus

Warung langganan ngembaliin roti yang udah diinvoice (rusak/gak laku/salah kirim). Piutang harus berkurang, tapi ini **beda dari `cancel_ar_invoice`** — retur itu kejadian bisnis nyata (barang beneran balik), bukan koreksi "salah input". Bisa juga cuma **sebagian** dari invoice (retur 2 dari 10 roti), bukan seluruh invoice.

## Kenapa ditunda

`cancel_ar_invoice` (lihat `memory/architecture/data/ar-schema.md`) cuma nutup kasus "invoice salah dari awal, batalin total, belum ada payment". Retur butuh entitas/logic beda:
- Bisa **partial** (bukan all-or-nothing kayak cancel).
- Bisa kejadian **setelah** ada payment (barang dipakai dulu, baru ketauan rusak, padahal udah kebayar) — beda dari guard `cancel_ar_invoice` yang nolak keras kalau udah ada alokasi.
- Butuh keputusan: kurangi `ar_invoices.amount` (tapi itu ngelanggar immutability) atau bikin baris "credit note" terpisah yang ngurangin outstanding invoice tanpa ubah `amount` asli.

## Kapan perlu digarap

Begitu ada laporan retur beneran kejadian di cerita CV Roti Barokah, atau modul Inventory (Fase 5) mulai dibangun (retur roti = barang balik ke stok, butuh sinkron ke situ juga).

## Referensi

- `docs/domain/accounts-receivable.md` (bagian "Belum Termasuk")
- `memory/architecture/data/ar-schema.md` (bagian "Belum termasuk")
