# AR — Resolusi Return Credit Cuma Refund Kas atau Ganti Barang (No Titip/Apply ke Invoice Lain)

**Modul asal:** Accounts Receivable (Fase 3, sudah live). **Status:** Ditunda.

## Kasus

Lanjutan keputusan Versi B (lihat `memory/scope-debt/ar-payment-strict-invoice-match.md`). `ar_return_credits` (saldo yang lahir **otomatis** dari `create_ar_credit_note` pas retur bikin outstanding invoice minus — invoice udah kelanjur lunas duluan, retur nyusul belakangan) **TIDAK ikut kehapus** oleh aturan payment-strict-invoice-match — beda akar sebab (lahir dari timing retur vs invoice lunas, bukan dari cara bayar).

Contoh konkret: invoice Rp 100.000 udah lunas. Seminggu kemudian barang senilai Rp 20.000 diretur (basi). Karena invoice udah lunas, retur ini bikin `ar_return_credits` Rp 20.000 otomatis tercatat — "Bu Nur berutang Rp 20.000 ke warung ini".

Keputusan bisnis (2026-08-07): satu-satunya cara nyelesain saldo ini cuma **2** — (a) refund tunai ke customer, (b) ganti barang (`warranty_replacement`) — **TIDAK BOLEH** "dititip"/dipakai motong invoice lain di kemudian hari (jalur `apply_ar_return_credit` yang sekarang ada).

Ditemukan juga gap teknis terpisah pas analisis ini: `warranty_replacements` (migration `0026`, diperluas `0037`) sekarang **berdiri sendiri**, gak pernah nyentuh/ngurangin `ar_return_credits` — padahal keduanya bisa lahir dari credit note yang sama. Kalau retur diselesaikan lewat ganti barang, `ar_return_credits` yang kadung otomatis lahir tetap "kebuka"/gak keurus, laporan piutang jadi salah (nunjukin Bu Nur masih berutang padahal udah lunas via barang).

Keputusan teknis (Cara 1, dipilih user dari 2 opsi yang ditawarkan): `create_warranty_replacement` perlu diperluas — kalau credit note yang dirujuk punya `ar_return_credits` aktif (belum sepenuhnya di-refund), replacement barang otomatis catat "penyelesaian" ke situ (analog refund, tapi dibayar barang bukan kas), ngurangin sisa `ar_return_credit_remaining()`. Ditolak: opsi alternatif "user pilih resolusi (kas/barang) di awal pas catat retur" — gak dipilih karena keputusan ganti-barang seringnya baru diambil belakangan, bukan pas retur dicatat.

## Kenapa ditunda

- Tabel `ar_return_credit_applications` dihapus total (jalur "titip saldo, dipakai motong invoice lain kapan pun" ditutup).
- RPC `apply_ar_return_credit` (`0031_ar_return_credits_and_remaining_refactor.sql`) dihapus total.
- Trigger `ar_return_credit_applications_guard` dan `ar_return_credit_applications_block_edit_delete` dihapus (gak relevan lagi).
- Fungsi `ar_return_credit_remaining(credit_id)` perlu ditulis ulang — sekarang ngurangin dari `ar_return_credit_applications` + `ar_return_credit_refunds`, nanti tinggal `ar_return_credit_refunds` + (baru) penyelesaian lewat warranty_replacement.
- Desain persis penyimpanan "penyelesaian via barang" belum final — 2 opsi belum diputuskan: tabel baru mirip `ar_return_credit_refunds` tapi sumbernya beda, ATAU extend `ar_return_credit_refunds` dengan kolom `settlement_type` (CASH/GOODS) + `warranty_replacement_id` nullable. Perlu ERD ulang dulu sebelum migration ditulis.
- `create_warranty_replacement` perlu logic baru: hitung proporsi value barang pengganti terhadap `ar_return_credit_remaining()`, journal entry tambahan (mirip pola pembalikan diskon proporsional di `0037`), guard anti-over-settle (analog `warranty_replacements_no_over_reverse`).
- `docs/domain/accounts-receivable.md` bagian "Saldo Kredit dari Retur" dan "Penukaran Barang Pasca-Retur (Garansi)" perlu direvisi bareng — sebelumnya ditulis independen, sekarang 2 mekanisme itu saling terhubung.
- Bergantung urutan sama `ar-payment-strict-invoice-match.md` — logisnya digarap bareng/setelah itu, karena keduanya sama-sama menutup "jalur titip saldo bebas" di modul AR.

## Referensi

- `docs/domain/accounts-receivable.md` — bagian "Saldo Kredit dari Retur", "Penukaran Barang Pasca-Retur (Garansi)"
- `memory/architecture/data/ar-schema.md` — DDL `ar_return_credits`, `warranty_replacements`, RPC `create_ar_credit_note`/`apply_ar_return_credit`/`create_warranty_replacement`
- `memory/scope-debt/ar-payment-strict-invoice-match.md` — keputusan induk (Versi B) yang memicu tinjauan ini
