---
name: add-scope-debt
description: Membuat entry scope-debt baru dengan format baku saat sebuah keputusan desain sengaja ditunda selama pembangunan fitur. Gunakan saat menemukan kasus/gap yang keluar dari scope saat ini tapi perlu dicatat biar gak hilang dari radar.
---

# Add Scope-Debt

Bikin file baru di `memory/scope-debt/<nama-kebab-case>.md` dengan format baku, konsisten sama file scope-debt yang sudah ada.

## Template wajib

```markdown
# <Judul Singkat>

**Modul asal:** <nama modul, fase roadmap>. **Status:** Ditunda.

## Kasus

<Kasus/skenario konkret yang memunculkan gap ini — pakai contoh nyata kalau ada, bukan abstrak>

## Kenapa ditunda

<Alasan teknis/desain kenapa ini di luar scope saat ini — sebutkan keterbatasan schema/RPC/trigger yang jadi penghalang>

## Referensi

- <link balik ke domain doc terkait, `docs/domain/*.md` dan/atau `memory/domain/*.md`>
- <link balik ke schema doc terkait, `memory/architecture/data/*.md`, kalau ada>
```

## Aturan penamaan & isi

- Nama file kebab-case deskriptif, tanpa prefix nomor (`memory/preferences/system/md-file-naming.md`).
- **Jangan taruh detail lengkap di domain doc atau schema doc utama.** Gak ada lagi section "Belum Termasuk" di `docs/domain`, `docs/architecture`, `memory/domain`, maupun `memory/architecture/data` (lihat `AGENTS.md` > "Format Baku: Struktur Module → Submodule") — cukup sebutkan ringkas gapnya **inline**, di prosa/tabel submodule yang relevan (misal di bullet "Cara Kerja" buat domain doc, atau baris "Aturan Bisnis → RPC"/"Alur Teknis" buat architecture doc), dengan referensi `memory/scope-debt/<nama-file>.md`. Detail lengkapnya tetap di file scope-debt terpisah.
- Setelah file dibuat, tambahkan entry-nya ke daftar scope-debt "masih Ditunda" di `memory/brief.md`.
- Kalau gap ini punya padanan yang sudah diselesaikan di modul lain (misal AR vs AP), sebutkan perbandingannya di bagian "Kenapa ditunda" biar konteksnya jelas kenapa gak konsisten ditangani sekarang.
