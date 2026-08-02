# Form Components & Background — Design Reference

Lanjutan dari `admin-shell-design.md` (sekarang pola ERPNext: list-view padat + detail-view polos, bukan card-grid). Warna aksen di dokumen ini di-supersede jadi ERPNext blue (lihat bagian "Warna aksen" di bawah) — masih 1 warna aksen dominan, bukan multi-warna. Bagian form-nya dipakai di semua halaman yang ada input (login, signup, tambah data, dst), biar gak ada 3 gaya input beda di 3 halaman.

## Background

- **Halaman**: `bg-slate-100` (abu-abu kebiruan sangat muda) — bukan putih polos, bukan abu gelap. Ini yang bikin kartu/input putih di atasnya kekontras tanpa perlu border tebal.
- **Kartu & input field**: `bg-white` solid.
- **Border default**: `border-slate-200` (bukan `border-black/10`) — konsisten sama tone kebiruan background.
- **Light-only, gak ada dark mode** — sengaja di-drop semua class `dark:` dari komponen/halaman (termasuk media query dark di `globals.css`). Satu tampilan konsisten, gak perlu jaga 2 versi warna tiap komponen baru.

## Warna aksen

**Ganti dari amber-500 ke blue-600** (`#2490EF`-ish, ERPNext brand blue) — supersede versi lama. Tetap 1 warna aksen dominan, dipakai buat: tombol primary, focus ring input, link aktif, item sidebar aktif. Jangan nambah warna aksen kedua.

Migrasi: semua `amber-500`/`amber-600`/`amber-500/40` di komponen existing (`src/components/ui/*`, `sidebar.tsx`, `topbar.tsx`) diganti `blue-600`/`blue-700`/`blue-600/40` pas implementasi jalan.

## Komponen

### Label
Wajib ada di atas tiap field — jangan cuma mengandalkan `placeholder` sebagai satu-satunya penjelasan (placeholder hilang begitu user mulai ngetik, jelek buat aksesibilitas & buat field yang lagi diisi).
```
text-sm font-medium text-slate-700
```

### Text/email/password Input
```
w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm
placeholder:text-slate-400
focus:outline-none focus:ring-2 focus:ring-blue-600/40 focus:border-blue-600
```

### Select
Sama kayak input di atas (border, radius, focus ring) — biar visual konsisten, gak ada 2 gaya field beda cuma karena satu `<input>` satu `<select>`.

### Button — Primary
Aksi utama sebuah form (submit, simpan). Cuma 1 per form.
```
rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white
hover:bg-blue-700
disabled:opacity-50 disabled:cursor-not-allowed
```

### Button — Secondary
Aksi sekunder (batal, keluar, aksi non-destruktif lain).
```
rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700
hover:bg-slate-50
```

### Button — Toolbar (list view)
Tombol kecil di toolbar list view (`+ New`, Filter, Sort, Refresh) — lihat `admin-shell-design.md` poin 2. Lebih kecil dari button form biasa, dipakai berjejer.
```
rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600
hover:bg-slate-50
```
Varian `+ New` (primary di toolbar):
```
rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white
hover:bg-blue-700
```

### Form error text
Di bawah field yang error, atau di bawah form buat error dari server.
```
text-sm text-red-600
```

### Form helper/description text
Penjelasan tambahan non-error (contoh: "min. 6 karakter").
```
text-sm text-slate-500
```

## Spacing

- Antar field dalam 1 form: `gap-4`.
- Dalam 1 field (label ke input): `gap-1.5`.
- Card/panel yang isinya form: `p-6` sampai `p-8`, `rounded-xl`, `border border-slate-200`, `bg-white`, shadow lembut (`shadow-sm`).

## Kenapa dijadiin komponen reusable, bukan className diulang tiap halaman

3 halaman yang udah ada (`login`, `signup`, `/accounts` form tambah akun) masing-masing nulis className Tailwind sendiri-sendiri buat input/button — gampang ke-drift (satu halaman keupdate, yang lain kelewat). Solusinya: 1 komponen (`Input`, `Select`, `Label`, `Button`, `FormError`) di `src/components/ui/`, dipakai ulang di semua form ke depan (termasuk form Journal Entry nanti).
