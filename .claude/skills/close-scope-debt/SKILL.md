---
name: close-scope-debt
description: Menutup item scope-debt yang sudah selesai diimplementasi — verifikasi status, minta konfirmasi user, hapus file, dan bersihkan referensi mati di domain/architecture docs. Gunakan tiap kali user bilang sebuah scope-debt sudah beres/diimplementasi, atau saat migration baru ternyata menutup salah satu item di memory/scope-debt/.
---

# Close Scope-Debt

Operasionalisasi rule di `memory/brief.md` / `AGENTS.md`: item scope-debt yang statusnya "Selesai" harus dihapus filenya, bukan dibiarkan numpuk sebagai arsip.

## Langkah

1. **Identifikasi file** — cari file yang relevan di `memory/scope-debt/*.md` berdasarkan nama/konsep yang disebut user.

2. **Verifikasi bukti selesai.** Jangan percaya klaim "udah selesai" begitu saja:
   - Apakah ada migration SQL yang mengimplementasikan keputusan di file itu (`supabase/migrations/*.sql`)?
   - Apakah `memory/architecture/data/*.md` yang relevan sudah mendokumentasikan hasil finalnya?
   - Kalau gak ketemu buktinya, jangan lanjut — tanya user migration/kode mana yang menutup ini.

3. **Tampilkan ringkasan ke user, WAJIB MINTA KONFIRMASI dulu** sebelum menghapus apa pun:
   - Nama file scope-debt yang mau dihapus
   - Bukti selesainya (migration/kode terkait)
   - Daftar file lain yang mereferensikan file scope-debt ini (grep nama filenya di seluruh `memory/` dan `docs/`) beserta preview perubahan yang akan dibuat di masing-masing (link mati dihapus dari kalimat, ringkasan keputusan tetap ada inline di prosa sekitarnya — jangan hapus seluruh kalimat)

   Ini **wajib nunggu user bilang ya** — jangan hapus otomatis meski buktinya kelihatan jelas.

4. **Setelah dikonfirmasi:**
   - Hapus file scope-debt-nya (`git rm` kalau sudah tracked)
   - Edit tiap file yang mereferensikannya untuk menghapus link mati (pola: hapus klausa `+ \`memory/scope-debt/nama-file.md\`` dari kalimat yang menyebutnya, jangan hapus seluruh kalimat)

5. **Update index** — hapus entry file itu dari daftar scope-debt "masih Ditunda" di `memory/brief.md`, tambahkan catatan singkat kalau perlu (pola: lihat bagaimana `fixed-assets-akun-kontra-asset.md` dicatat setelah dihapus).

## Referensi implementasi sebelumnya

Proses ini sudah pernah dijalankan manual untuk `fixed-assets-akun-kontra-asset.md`. Cek histori git di `memory/domain/chart-of-accounts.md`, `memory/domain/fixed-assets.md`, `docs/domain/chart-of-accounts.md`, `docs/domain/fixed-assets.md`, dan `memory/architecture/data/fixed-assets-schema.md` untuk lihat pola persisnya kalau ragu.
