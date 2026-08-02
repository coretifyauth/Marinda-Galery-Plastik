# Format Dokumentasi Schema (architecture/data/)

Tiap file `.md` di `memory/architecture/data/` gak boleh cuma dump SQL mentah. Wajib ada penjelasan deskriptif humanable, ditulis dalam bahasa natural (bukan komentar SQL), buat tiap tabel dan tiap RLS policy.

## Struktur wajib per tabel

Sebelum blok ```sql```, jelasin:
- Tabel ini buat apa (1-2 kalimat)
- Kolom yang gak self-explanatory dari namanya — kenapa dia ada, kenapa tipe/constraint-nya begitu (generated column, self-FK, composite PK, dll)
- Kaitan ke keputusan lain (link ke domain doc / preference doc yang relevan)

## Struktur wajib per RLS policy

Sebelum blok ```sql``` RLS, jelasin tiap policy:
- Siapa yang match kondisinya
- Kenapa dibatesin/gak dibatesin ke situ (alasan bisnis, bukan cuma ulang syntax SQL-nya)
- Kalau sengaja gak ada policy tertentu (misal gak ada DELETE), jelasin implikasinya (default deny RLS = ketutup total)

## Kenapa

SQL doang gak nyampein *kenapa* — orang (atau agent) yang baca 6 bulan lagi harus reverse-engineer niat dari syntax. Penjelasan humanable di sebelah DDL bikin schema doc kebaca kayak dokumentasi, bukan cuma migration dump.

Contoh penerapan: `memory/architecture/data/coa-schema.md`.
