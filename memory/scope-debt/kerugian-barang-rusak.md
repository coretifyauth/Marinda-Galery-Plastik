# Kerugian Barang Rusak (Spoilage/Write-off) — Lintas Modul AR & AP

**Modul asal:** Lintas modul (Accounts Receivable Fase 3 + Accounts Payable Fase 4). **Status:** Ditunda.

## Kasus

**Sisi AR** — Customer minta barang pengganti karena barang rusak (`warranty_replacement`, sudah diimplementasi — `memory/domain/accounts-receivable.md` bagian "Penggantian Barang Gratis Pasca-Retur"). Alur retur full saat ini (`create_ar_credit_note`) mencatat barang yang diretur balik ke inventory sebagai lot baru (`source_type = SALES_RETURN`, FIFO) atau nambah `inventory_balances` (Weighted Average) — seolah barang itu stok layak jual biasa. Padahal kalau alasan returnya BARANG RUSAK (bukan retur biasa karena alasan lain, misal salah pesan), barang itu semestinya gak masuk lagi jadi stok bernilai — harusnya diklaim balik dari customer lalu diakui sebagai Beban Kerugian Barang Rusak (write-off), bukan ditambahkan ke `inventory_lots`/`inventory_balances` seolah barang baik yang bisa dijual lagi.

**Sisi AP** — Retur barang rusak ke supplier (fitur AP Retur Barang, migration `0035_ap_credit_notes_schema.sql` — per 2026-08-06 dikeluarkan dari scope fitur itu), tapi supplier MENOLAK ganti rugi sama sekali (gak mau kurangin Utang Usaha, gak mau kirim barang pengganti). Barokah harus nanggung sendiri kerugian itu:
```
Debit Beban Kerugian Barang Rusak   [nilai barang rusak]
  Kredit Persediaan Bahan Baku          [nilai barang rusak]
```
Murni kerugian, **bukan** retur — gak ada interaksi ke Utang Usaha/supplier sama sekali. Beda mendasar dari retur yang selalu ada kompensasi dari counterparty (entah ngurangin utang/piutang, atau ganti barang) — di sini kompensasinya nol, kerugian ditanggung sendiri oleh Barokah.

## Kenapa ditunda

Baru ketauan saat diskusi desain fitur AP Retur Barang (2026-08-06) — user eksplisit minta ini dicatat terpisah dari retur, karena beda sifat fundamental: **retur** = selalu ada kompensasi dari counterparty (supplier ngurangin utang, atau ganti barang 1:1); **write-off/spoilage** = kompensasi nol, kerugian ditanggung sendiri, diakui sebagai beban di laporan laba-rugi. Belum ada kejadian ini di cerita CV Roti Barokah baik sisi AP maupun AR, jadi belum ada tekanan nyata buat didesain sekarang.

Padanan sisi AR (`warranty_replacement`) sudah diimplementasi tapi belum menangani kasus ini — gap-nya ada di titik yang sama (barang rusak balik ke inventory seolah barang baik), cuma baru kebukti pas desain AP karena AP butuh cabang eksplisit "supplier nolak ganti" yang gak ada padanannya waktu AR dibangun (AR selalu asumsi kita yang ganti, gak pernah bahas "customer nolak retur = kita nanggung sendiri").

## Referensi

- `memory/domain/accounts-receivable.md` bagian "Penggantian Barang Gratis Pasca-Retur" (`ar_credit_notes` migration `0021`, `warranty_replacement` migration `0026`) — sisi AR yang perlu direvisit.
- `memory/architecture/data/ap-schema.md` bagian "AP Credit Note (Retur Barang ke Supplier)" — fitur AP Retur Barang (migration `0035`), sengaja gak mencakup kasus ini.
