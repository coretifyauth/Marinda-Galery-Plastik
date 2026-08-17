---
name: tutorial
description: Membangun, update, atau adjust user guide operasional di docs/tutorial/ — instruksi langkah-demi-langkah "klik di mana, isi apa" untuk end user (staff akuntansi/gudang) menjalankan satu task/workflow di aplikasi, lintas modul kalau perlu. Beda dari docs/domain (konsep akuntansi) dan docs/architecture (skema teknis). Gunakan hanya saat diminta eksplisit lewat /tutorial — tidak auto-trigger.
---

# Tutorial (User Guide)

Skill ini menulis/memperbarui dokumentasi **operasional untuk end user** — orang yang menjalankan aplikasi ERP ini sehari-hari (staff akuntansi, gudang, kasir POS), bukan developer. Fokusnya "bagaimana cara melakukan X di aplikasi", bukan "kenapa X secara akuntansi" (itu `docs/domain/`) dan bukan "bagaimana skema data X" (itu `docs/architecture/`).

Trigger manual saja — dipakai ketika user eksplisit minta `/tutorial [nama task]` atau minta tutorial dibuat/diupdate. Tidak nge-gate proses `new-feature` dan tidak auto-suggest setelah fitur baru selesai.

## Lokasi & granularity

- Output: `docs/tutorial/<modul>/<nama-task-kebab-case>.md` — **disegmentasi per modul** (folder), bukan flat lagi di root `docs/tutorial/`. Modul yang sudah ada: `chart-of-accounts`, `general-ledger`, `accounts-receivable`, `accounts-payable`, `inventory`, `fixed-assets`, `financial-reports`, `pos`, `settings`, `lintas-modul` (buat task yang genuinely lintas modul dan gak lebih milik satu modul tertentu, mis. cetak dokumen, arsip master data — jangan taruh sini kalau task-nya sebenarnya jelas milik 1 modul spesifik walau menyentuh tabel modul lain).
- Modul baru (di luar daftar di atas) boleh ditambah kalau memang belum ada yang cocok — cukup buat foldernya, viewer app (`apps/erp/src/app/docs/`) otomatis nge-list folder baru sebagai modul (fallback label title-case dari nama folder). Kalau mau label rapi & posisi urut yang pasti (bukan fallback), tambahkan juga entry di `MODULE_LABELS`/`MODULE_ORDER` (`apps/erp/src/lib/docs/fs.ts`).
- Satu file = **satu task/workflow konkret**, bukan satu modul. Task boleh melintasi beberapa modul/halaman sekaligus kalau memang begitu alurnya di dunia nyata (mis. `tutup-periode-akuntansi.md` bisa menyentuh General Ledger + Financial Reports) — taruh di folder modul yang paling "memiliki" task itu dari sudut pandang user, bukan sekadar modul yang paling banyak disebut di kode.
- Penamaan file pakai kata kerja/aktivitas nyata yang dilakukan user, bukan nama modul (`buat-invoice-ar.md`, bukan `ar-invoices.md`).
- **Cross-reference antar tutorial pakai link markdown relatif** (bukan backtick kayak `docs/domain`/`docs/architecture`, karena tutorial memang didesain buat diklik-jelajah lewat viewer app):
  - Ke file lain di modul yang sama: `[buat-jurnal-manual.md](buat-jurnal-manual.md)`.
  - Ke file di modul lain: `[tambah-akun-baru.md](../chart-of-accounts/tambah-akun-baru.md)` — path relatif filesystem asli (biar tetap valid kalau file-nya dibuka langsung/di GitHub, bukan cuma lewat app), viewer resolve otomatis ke rute yang benar (`apps/erp/src/components/docs/markdown-content.tsx`).

## Prinsip utama: harus cocok dengan UI yang benar-benar berjalan

Ini dokumen yang dipakai orang buat klik tombol beneran — kalau label field/tombol di tutorial gak sama dengan yang ada di aplikasi, tutorialnya lebih berbahaya daripada gak ada tutorial sama sekali. Karena itu:

1. **Jangan menulis dari ingatan/asumsi.** Sebelum menulis langkah, baca kode UI yang sebenarnya jalan untuk task itu — `page.tsx`/`view.tsx` dan komponen form terkait di `apps/erp/src/app/(app)/<modul>/`. Ambil label tombol, nama field, urutan step, dan pesan validasi persis dari situ.
2. **Kalau ada logic kondisional di UI** (tombol disabled kalau X, field muncul cuma kalau Y), sebutkan syaratnya di tutorial — itu sering jadi sumber kebingungan user asli.
3. **Update, bukan tebak ulang.** Kalau diminta "adjust" tutorial yang sudah ada karena UI berubah, cek dulu bagian mana yang beneran berubah (diff kode vs isi tutorial existing), jangan tulis ulang seluruh file dari nol.
4. Kalau butuh verifikasi visual (bukan cuma baca kode), skill `run` bisa dipakai untuk menjalankan app dan screenshot alurnya — opsional, tapi berguna untuk task dengan banyak state visual (mis. wizard multi-step, print preview).

## Gaya bahasa

- Untuk end user non-teknis: instruksi imperatif langsung ("Klik **Simpan**", "Isi kolom **Nomor Referensi**"), bukan penjelasan sistem.
- Istilah akuntansi yang muncul (mis. "posting", "periode tutup buku") boleh dipakai karena target usernya staff akuntansi, tapi tidak perlu dijelaskan konsepnya di sini — cukup link ke `docs/domain/<modul terkait>.md` kalau user perlu paham "kenapa"-nya.
- Bahasa Indonesia, konsisten dengan gaya `docs/domain/` yang sudah ada.

## Format baku per file

```markdown
# <Nama Task, dalam bentuk aktivitas> — <target user singkat kalau relevan>

## Kapan Melakukan Ini
Situasi/pemicu nyata yang bikin user perlu jalanin task ini.

## Prasyarat
Kondisi yang harus sudah terpenuhi sebelum mulai (data master ada, periode masih terbuka, role/permission tertentu, dst). Sebutkan eksplisit kalau prasyaratnya berasal dari modul lain.

## Langkah-Langkah
1. Numbered steps, mengacu ke label UI persis (nama halaman, nama tombol, nama field).
   - Kalau task melintasi beberapa halaman/modul, tandai jelas transisinya ("Setelah tersimpan, buka halaman **Goods Issue**...").
2. ...

## Hasil Akhir
Apa yang seharusnya terjadi setelah selesai — status berubah, jurnal otomatis terbentuk, dokumen baru muncul di halaman lain, dst. Ini juga jadi cara user memverifikasi sendiri kalau langkahnya sudah benar.

## Kesalahan Umum
Kesalahan level operasional (bukan level konsep akuntansi) — "lupa isi field X jadi tombol Post kedisabled", "salah pilih akun default", "urutan step kebalik". Beda dari "Common Mistakes" di docs/domain yang levelnya kesalahan pemahaman akuntansi, bukan kesalahan klik.
```

## Alur kerja

1. **Klarifikasi task** — kalau user cuma bilang "buatin tutorial [modul]" tanpa task spesifik, tanya balik task/workflow konkret apa yang dimaksud (task, bukan modul) — satu modul bisa punya beberapa tutorial task berbeda.
2. **Tentukan folder modul** — pakai daftar modul yang sudah ada (lihat "Lokasi & granularity") kalau task-nya cocok ke salah satu; folder baru cuma dibuat kalau memang belum ada yang pas.
3. **Baca UI aktual** — susuri page/view/form component yang relevan untuk task itu, ikuti urutan interaksi user senyatanya (termasuk state kondisional).
4. **Cek referensi domain** kalau ada istilah/keputusan bisnis yang perlu dilink, bukan dijelaskan ulang — `docs/domain/<modul>.md`.
5. **Tulis/update file** di `docs/tutorial/<modul>/` sesuai format baku di atas — pakai link relatif yang benar kalau cross-reference ke modul lain (lihat aturan link di atas).
6. **Kalau update existing file**, tunjukkan ke user bagian mana yang berubah dan kenapa (biasanya karena UI berubah), bukan cuma bilang "sudah diupdate".
