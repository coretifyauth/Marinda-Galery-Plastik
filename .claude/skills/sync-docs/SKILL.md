---
name: sync-docs
description: Mengecek apakah pasangan dokumentasi teknis (memory/) dan naratif (docs/) untuk sebuah topik masih sinkron, dan menandai (bukan otomatis menulis ulang) bagian yang perlu diupdate manusia. Gunakan setelah mengubah memory/domain/*.md, memory/architecture/data/*.md, docs/domain/*.md, atau docs/architecture/*.md.
---

# Sync Docs Check

Project ini punya 2 salinan dokumentasi per topik yang sengaja dipisah level bahasanya (lihat `AGENTS.md` bagian "Docs Structure Overview"):

- `memory/domain/<x>.md` ↔ `docs/domain/<x>.md`
- `memory/architecture/data/<x>-schema.md` ↔ `docs/architecture/<x>-schema.md`

Risiko keduanya drift (satu diupdate, satunya lupa) makin besar seiring waktu, karena isinya sengaja gak identik (beda level bahasa), jadi gak bisa dicek otomatis lewat diff biasa.

## Langkah

1. Begitu selesai mengedit salah satu sisi (`memory/...` atau `docs/...`) untuk sebuah topik, baca pasangannya di sisi lain.
2. **Jangan otomatis menulis ulang pasangannya.** Ini butuh judgment (bahasa naratif vs teknis beda gaya, bukan terjemahan 1:1). Cukup laporkan ke user: bagian apa yang berubah di sisi yang baru diedit, dan apakah sisi pasangannya perlu penyesuaian.
   - **Biasanya perlu diupdate:** keputusan desain baru/berubah, entity/kolom baru, aturan bisnis baru, constraint baru.
   - **Biasanya gak perlu:** detail implementasi teknis murni (nama variabel internal, index tambahan buat performa) yang gak mengubah cara kerja dari sudut pandang user.
3. Kalau user minta diupdate juga, baru tulis versi pasangannya — ikuti struktur module → submodule baku (`AGENTS.md` > "Format Baku: Struktur Module → Submodule") dan gaya yang sudah ada di file sejenis di folder itu:
   - `docs/domain`: `###` per submodule, bold label **Cara Kerja**/**Aturan Bisnis**/**Skenario**/**Common Mistakes**, bahasa non-teknis, hindari nama RPC/trigger/tabel/kolom/migration.
   - `docs/architecture`: `##` per submodule, semua konten dalam tabel markdown (**Peta Data (ERD)**/**Alur Teknis (RPC)**/**Aturan Bisnis → RPC**/**Interaksi Antar Tabel**), plus ringkasan ERD semua tabel di level modul.
   - `memory/domain` & `memory/architecture/data`: struktur module → submodule yang sama, tapi padat & teknis (boleh kode SQL/nama fungsi/tabel/kolom langsung).
   - **Posisi & pengelompokan submodule harus identik** antara domain ↔ architecture di folder yang sama — kalau nambah/gabung submodule di satu sisi, sisi pasangannya (baik `docs/` maupun `memory/`) wajib disesuaikan juga, bukan cuma kontennya.

## Kapan skill ini TIDAK perlu dipanggil

Perubahan yang murni kosmetik (typo, rewording tanpa ubah makna) di salah satu sisi gak perlu dicek ke sisi lain.
