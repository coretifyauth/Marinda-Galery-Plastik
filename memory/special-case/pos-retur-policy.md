# POS — Kebijakan Retur Barang di Kios

**Modul asal:** POS/Jualan Eceran (sudah dibangun & jalan per 2026-08-09, `apps/pos` — lihat `memory/domain/pos.md`; retur belum termasuk di build ini). **Status:** Grey area — menunggu keputusan owner.

## Kondisi

Kios Toko Plastik Makmur Jaya (`apps/pos`) jual barang plastik rumah tangga tunai langsung ke pelanggan walk-in. Belum ada keputusan jelas dari Pak Herman soal: kalau pelanggan mau retur barang yang udah dibeli di kios (rusak, gak sesuai, dll), apakah itu boleh atau enggak.

## Kenapa ini grey area, bukan scope-debt

Beda dari item scope-debt biasa (yang nunggu tekanan/bukti kebutuhan teknis buat mulai dikerjakan), ini bukan soal kesiapan teknis — bikin retur POS secara teknis gak sulit (tinggal reuse pola `ar_credit_note`, klasifikasi kondisi RESALABLE/DAMAGED yang udah ada di AR, lihat `memory/domain/accounts-receivable.md` submodule "Retur Barang"). Yang belum ada itu **keputusan kebijakan bisnisnya sendiri** — apakah Pak Herman mau kios-nya punya kebijakan "barang yang sudah dibeli tidak dapat dikembalikan" (umum di retail kecil, transaksi tatap muka) atau mau kasih fleksibilitas retur. Ini keputusan yang cuma bisa diambil owner, bukan sesuatu yang bisa diasumsikan/dibangun duluan.

## Opsi yang dipertimbangkan

- **Tidak boleh retur sama sekali** — kebijakan retail umum, paling sederhana buat kios kecil transaksi tatap muka (beda dari AR: barang dikirim ke warung langganan, retur karena masalah di jalan/waktu itu wajar; kios beli-bayar-bawa langsung, masalah biasanya ketauan di tempat sebelum bayar).
- **Retur diperbolehkan dengan syarat** (misal: hari yang sama, struk masih ada, barang belum dikonsumsi) — POS butuh mekanisme retur sendiri, kemungkinan reuse pola `ar_credit_note` (kontra-revenue + klasifikasi kondisi RESALABLE/DAMAGED).

## Sikap sementara (sampai diputuskan)

POS v1 dibangun **tanpa** mekanisme retur — bukan berarti "tidak boleh retur" secara permanen, tapi karena kebijakannya belum diputuskan. Kalau ada pelanggan kios yang mau retur sebelum keputusan ini diambil, ditangani manual di luar sistem (sama seperti sekarang, sebelum POS ada).

## Kapan perlu diputuskan

Sebelum atau saat POS mulai dipakai beneran di kios — Pak Herman perlu eksplisit menentukan kebijakan retur kiosnya. Begitu diputuskan (arah manapun), keputusan itu masuk jadi Aturan Bisnis permanen di `docs/domain/pos.md` + `memory/domain/pos.md`, dan file ini dihapus (siklus hidup sama seperti scope-debt, lihat `memory/brief.md` > "Aturan siklus hidup dokumen").

## Referensi

- `memory/domain/accounts-receivable.md` submodule "Retur Barang (Credit Note)" — pola teknis yang bisa di-reuse kalau nanti diputuskan boleh retur.
