# Admin Shell & Entity Detail Page — Design Reference

## Sumber

Screenshot referensi dashboard HR SaaS ("HRMent" — halaman detail staff) yang dikasih user. Yang diambil di sini cuma **pola struktural/visual**-nya, BUKAN konten HR-nya — field "Education information", "Marital status", dll gak relevan ke domain akuntansi kita. Kalau bikin halaman detail buat entity kita sendiri (Account, Journal Entry, dst), pola di bawah ini yang jadi acuan, isinya menyesuaikan domain.

## 1. App Shell (berlaku di semua halaman, gak cuma detail page)

- **Sidebar kiri persisten** — logo+nama app di atas, list menu utama (icon+label), beberapa item collapsible (chevron di kanan buat submenu).
- **Item menu aktif** ditandai warna aksen + garis vertikal tipis di kiri item — bukan cuma ganti warna teks doang.
- **Top bar** — kiri: konteks organisasi/workspace yang lagi aktif (kalau nanti multi-entity/multi-cabang). Kanan: ikon notifikasi + user menu (avatar + nama + chevron dropdown).
- **Breadcrumb** di bawah top bar: `Modul / Sub-list / Detail` — jejak navigasi hierarkis, bukan cuma judul halaman polos.

## 2. Entity Detail Page — pola reusable

Ini yang paling kepake ulang ke depan (Account detail, Journal Entry detail, nanti Customer/Vendor pas AR/AP):

- **Tab horizontal** di bawah breadcrumb, mecah 1 entity jadi beberapa sub-view (di reference: Staff profile/Work information/Timesheet/Contracts/Payroll/Company assets). Dipakai kalau 1 entity punya beberapa "wajah" berbeda yang gak muat/gak related ditumpuk 1 halaman.
- **Header row** di atas (bukan di dalam kartu) — identitas utama entity: avatar/icon + nama + subtitle (role/kategori), plus beberapa field kunci rata kanan (ID, kontak). Ini ringkasan cepat, bukan detail lengkap.
- **Body berupa grid kartu** — tiap kartu putih rounded = **1 kelompok informasi tematik** (contoh: "Personal information", "Education information", "Account information"). Jangan 1 kartu raksasa isi semua field.
- **Ikon pensil (edit) di pojok kanan atas tiap kartu** — edit per-section, bukan 1 form besar buat seluruh entity.
- **Di dalam kartu**: pola label-value berulang — label kecil abu-abu di atas, value bold hitam di bawah, disusun 2 kolom per baris.

## 3. Visual style

- Background halaman abu-abu/biru sangat muda, kartu solid putih — kontras dari spacing & shadow lembut, bukan border tebal.
- Rounded corner besar di kartu & sidebar container, shadow halus (bukan flat/hard-edge).
- **1 warna aksen dominan doang** (di reference: orange) buat logo & state aktif/link — sisanya netral (hitam/abu-abu/putih). Jangan multi-warna random per section.
- Avatar bulat; subtitle/kategori (misal jabatan/departemen) ditulis teks kecil warna aksen di bawah nama — bukan pill/badge kotak.

## Kapan dipakai, kapan enggak

Pola tab+card ini pas buat halaman **"lihat detail 1 entity yang punya banyak sub-informasi"**. Buat halaman lain (form input transaksi kayak Journal Entry baru, atau list/tabel COA yang udah kita bangun di `/accounts`) gak wajib dipaksa ikut pola ini — form input tetap 1 halaman form biasa, list tetap tabel. App shell (poin 1) tetap berlaku di semua halaman.
