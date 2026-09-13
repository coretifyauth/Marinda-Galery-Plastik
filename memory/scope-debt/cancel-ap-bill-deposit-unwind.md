# cancel_ap_bill belum unwind deposit_applications

**Modul asal:** Accounts Payable / Deposits. **Status:** Ditunda.

## Kasus

`cancel_ar_invoice` punya loop unwind: kalau invoice yang dibatalkan sudah punya DP (`deposit_applications`) yang diterapkan lewat `apply_deposit`, jurnal penerapan DP itu ikut dibalik otomatis (`supabase/migrations/0015_transactions_schema.sql` baris 259-265). `cancel_ap_bill` TIDAK PERNAH punya loop yang sama -- termasuk setelah guard goods-receipt ditambahkan (2026-09-13, sekarang jadi bagian final `cancel_ap_bill` di `0015_transactions_schema.sql`), yang sengaja tidak menyentuh bagian ini.

Dampak: bill AP yang sudah punya DP diterapkan (via `apply_deposit`, arah INBOUND), kalau dibatalkan lewat `cancel_ap_bill`, akan menyisakan baris `deposit_applications` yang jurnalnya TIDAK ke-reverse. `deposit_remaining(deposit_id)` buat DP itu jadi understated secara permanen (DP dianggap masih "terpakai" ke bill yang sudah gak berlaku di GL) sampai diperbaiki manual.

`docs/architecture/deposits-schema.md` sebelumnya salah mendokumentasikan seolah-olah `cancel_ap_bill` juga melakukan unwind ini (baris "Alur Teknis (RPC)" dan "Aturan Bisnis → RPC") — sudah dikoreksi di sesi yang sama (2026-09-13) untuk mencerminkan kode yang sebenarnya, ditandai gap ini inline.

## Kenapa ditunda

Ditemukan (2026-09-13) sebagai efek samping review guard goods-receipt di `cancel_ap_bill` (schema-reviewer diminta cek dampak lain sekalian). Perbaikannya sederhana secara teknis (copy pola loop dari `cancel_ar_invoice`, arah dibalik), tapi tetap butuh migration terpisah + review sendiri, dan user belum diminta/mengonfirmasi mau digarap sekarang — dicatat dulu biar gak hilang dari radar sebelum fitur DP AP dipakai serius bareng pembatalan bill.

## Referensi

- `docs/architecture/deposits-schema.md` — baris "Invoice yang DP-nya sudah diterapkan dibatalkan" (Alur Teknis RPC) dan baris terkait di "Aturan Bisnis → RPC".
- `supabase/migrations/0015_transactions_schema.sql` baris 259-265 — pola loop unwind yang sudah ada di `cancel_ar_invoice`, jadi acuan kalau ini digarap.
