# AR — Penggantian Barang Gratis Pasca-Retur

**Modul asal:** Accounts Receivable, muncul pas desain AR Credit Note (Fase 3, digarap ulang bareng Inventory Fase 5). **Status:** Ditunda.

## Kasus

Customer balikin barang rusak (retur AR Credit Note sudah diimplementasi — lihat `memory/domain/accounts-receivable.md` bagian "Retur Barang") DAN minta barang pengganti — **tanpa nagih ulang**, karena ini garansi kualitas, bukan penjualan baru.

## Kenapa beda dari `create_goods_issue`

`create_goods_issue` (`memory/architecture/data/inventory-schema.md`) selalu bikin invoice baru (Debit Piutang, Kredit Pendapatan) + konsumsi stok + jurnal HPP. Penggantian gratis butuh **keluar stok + HPP doang**, tanpa piutang/pendapatan baru:

```
Debit Harga Pokok Penjualan (HPP)   [cost barang pengganti]
  Kredit Persediaan Barang Jadi            [cost barang pengganti]
```

Belum ada RPC yang nangani pola ini — semua jalur keluar stok yang ada sekarang (`create_goods_issue`, `create_production_order`) selalu terikat entitas lain (invoice/production order), gak ada jalur "stok keluar aja karena kewajiban garansi".

## Kenapa ditunda

Belum ada kejadian ini di cerita CV Roti Barokah — retur yang udah digarap (jurnal kontra-revenue + reversal HPP) cukup buat kasus "barang balik, gak diganti". Penggantian gratis nambah kompleksitas (RPC baru, keputusan apakah butuh referensi balik ke credit note aslinya) yang belum kebutuhan nyata.

## Kapan perlu digarap

Begitu ada skenario customer minta penggantian barang gratis (bukan cuma retur/refund) di cerita CV Roti Barokah.

## Referensi

- `memory/domain/accounts-receivable.md` (bagian "ar_credit_note")
- `docs/domain/accounts-receivable.md` (bagian "Retur Barang")
