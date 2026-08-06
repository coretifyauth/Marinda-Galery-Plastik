# Penggantian Barang Gratis AR (warranty_replacement) Bikin Kompensasi Ganda

**Modul asal:** Accounts Receivable (Fase 3, fitur sudah live). **Status:** Ditunda.

## Kasus

Ditemukan lewat diskusi mengajar (2026-08-06, contoh Pak Budi — `docs/story/accounts-receivable.md` Skenario 6 + 6b). Alur retur + ganti barang di AR saat ini (`create_ar_credit_note` + `create_warranty_replacement`, migration `0021`+`0026`) bersifat **ADDITIVE** (dua-duanya jalan bareng), bukan saling eksklusif:

- **Skenario 6** (25–28 Agustus 2026): Pak Budi beli 30 Roti Tawar Rp60.000, 3 apek diretur → tagihan didiskon Rp6.000 jadi **Rp54.000** (`Debit Retur & Potongan Penjualan / Kredit Piutang Usaha`).
- **Skenario 6b** (29 Agustus 2026): Pak Budi minta ganti 3 roti fresh, dikasih **gratis** tanpa nagih ulang (`Debit HPP / Kredit Persediaan Barang Jadi`, gak nyentuh Piutang/Pendapatan lagi).

**Hasil akhir**: Pak Budi dapat 30 roti baik (27 asli + 3 pengganti) tapi cuma bayar Rp54.000 — padahal kalau dia dari awal cuma minta **tukar barang** (gak minta diskon duluan), dia tetap bayar penuh Rp60.000 untuk 30 roti baik (adil, gak ada pihak dirugikan). Pola yang sekarang berjalan bikin Bu Nur "rugi" ekstra Rp6.000 dibanding seharusnya — customer dapat **diskon dari retur** DAN **barang pengganti gratis** sekaligus untuk 1 kejadian cacat yang sama. Ini kompensasi ganda yang gak masuk akal secara bisnis (analoginya: warung kasih uang balik untuk barang rusak, TAPI juga kasih barang gantinya gratis — mestinya pilih salah satu).

## Kenapa ditunda

Ini perbaikan ke fitur yang **sudah live di production** (migration `0021` `create_ar_credit_note` + `0026` `create_warranty_replacement`), bukan fitur baru yang lagi dibangun — yang lagi dibangun sekarang adalah AP Retur Barang (modul terpisah, `memory/domain/accounts-payable.md` bagian "AP Credit Note (Retur Barang)"), yang justru sudah didesain dari awal dengan pola **saling eksklusif** (Opsi A: kurangi utang, ATAU Opsi B: tukar barang — gak pernah dua-duanya) persis untuk menghindari masalah yang sama ini. Gap di AR ini baru ketauan lewat proses ngajarin AP, bukan sesuatu yang sengaja didesain begitu dari awal.

User eksplisit minta perilaku additive ini **dihapus/diperbaiki**, tapi ditunda dulu (bukan dikerjakan sekarang) — perlu didesain ulang dengan hati-hati karena ini fitur existing dengan data seed yang sudah mencontohkan pola lama (Skenario 6b). Opsi perbaikan yang mungkin:

- **(a) Jadikan saling eksklusif**, mirror pola AP Opsi A/B yang baru didesain — pilih SALAH SATU: diskon (credit note) ATAU ganti barang (replacement), gak dua-duanya untuk 1 kejadian retur yang sama.
- **(b) `warranty_replacement` wajib membalikkan/mengurangi diskon** yang sudah diberikan credit note, supaya total kompensasi net-nya tetap adil (customer bayar penuh kalau minta diganti).

Butuh keputusan bisnis dulu (opsi mana), baru migration buat benerin behavior existing (constraint/RPC), plus cek dampak ke data seed (`docs/story/accounts-receivable.md` Skenario 6b dan seed migration terkait) yang mencontohkan pola lama ini.

## Referensi

- `memory/domain/accounts-receivable.md` bagian "Penggantian Barang Gratis Pasca-Retur".
- `docs/domain/accounts-receivable.md` bagian yang sama.
- `docs/story/accounts-receivable.md` Skenario 6 & 6b (Pak Budi) — contoh konkret kompensasi ganda ini.
- `memory/architecture/data/ar-schema.md` — `create_warranty_replacement`, migration `0026`.
- `memory/domain/accounts-payable.md` bagian "AP Credit Note (Retur Barang)" Opsi A/B — pola saling eksklusif yang jadi rujukan perbaikan.
