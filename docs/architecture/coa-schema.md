# Chart of Accounts — Struktur Data

Fase 1. Konsep bisnisnya ada di `docs/domain/chart-of-accounts.md` — file ini fokus ke bagaimana datanya disimpan dan aturan apa yang dijaga otomatis oleh sistem. Kalau butuh detail teknis (kode SQL, nama fungsi persis), itu ada di `memory/architecture/data/coa-schema.md`.

## Peta Data (ERD)

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `roles` | Daftar peran yang dikenal sistem: `admin`, `accountant`, `viewer` | — |
| `user_roles` | Peran yang dipegang tiap user (1 user boleh punya lebih dari 1 peran) | `roles`, user login |
| `accounts` | Daftar akun (Chart of Accounts itu sendiri) | Bisa nunjuk ke akun lain sebagai "induk" (struktur header/leaf) |

**Struktur `accounts` (kolom yang penting buat dipahami):**

| Kolom | Isinya | Catatan |
|---|---|---|
| `code`, `name` | Kode & nama akun | Kode gak boleh dobel |
| `category` | asset / liability / equity / revenue / expense | 1 dari 5 kategori baku akuntansi |
| `normal_balance` | debit / kredit | **Dihitung otomatis** dari kategori, gak bisa diisi manual — lihat "Aturan Otomatis" |
| `is_contra` | ya / tidak | Penanda akun kontra (misal Akumulasi Penyusutan) — lihat `docs/domain/chart-of-accounts.md` bagian "Akun Kontra" |
| `parent_id` | menunjuk ke akun lain (atau kosong) | Ini yang bikin akun bisa jadi "header" (kalau punya anak) atau "leaf" (kalau gak punya anak) |
| status aktif/arsip | ada tidaknya tanggal arsip | Akun lama gak pernah dihapus permanen, cuma diarsipkan |

## Aturan Otomatis yang Dijaga Sistem

Sistem gak cuma nyimpen data — dia juga menolak input yang melanggar aturan akuntansi, tanpa perlu dicek manual satu-satu:

1. **Sisi normal (debit/kredit) gak bisa salah ketik.** Begitu kategori akun dipilih (misal "asset"), sisi normalnya otomatis kebentuk sendiri (debit) — gak ada kolom terpisah yang bisa diisi ngawur dan jadi gak nyambung sama kategorinya.
2. **Akun yang sudah pernah dipakai transaksi jadi "terkunci" sebagian.** Kode, kategori, sisi normal, posisi induk, dan status kontra sebuah akun gak bisa diubah lagi begitu akun itu pernah dipakai mencatat transaksi — mencegah histori laporan lama berubah makna secara diam-diam. Nama akun tetap boleh diganti kapan saja (misal typo).
3. **Akun yang sudah dipakai transaksi gak bisa "diam-diam" jadi header baru.** Kalau sebuah akun leaf sudah pernah diposting, sistem menolak penambahan akun anak baru di bawahnya — karena itu berarti akun itu jadi header, dan header gak boleh diposting langsung (aturan ini dijaga terpisah, lihat modul General Ledger).
4. **Akun tidak pernah benar-benar dihapus.** Yang bisa dilakukan cuma "arsipkan" — akun lama tetap ada di histori supaya laporan masa lalu tetap bisa dibaca dengan benar.

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar akun (termasuk yang diarsipkan) | Semua user yang sudah login |
| Menambah/mengubah akun | Role `admin` atau `accountant` |
| Menghapus akun secara permanen | **Tidak ada seorang pun** — ini sengaja ditutup total di level sistem, sesuai aturan "arsip, bukan hapus" |
| Melihat peran diri sendiri | User yang bersangkutan (gak bisa lihat peran user lain) |

## Belum Termasuk

- Fitur admin menetapkan peran ke user lain lewat aplikasi — sekarang masih dilakukan manual di luar aplikasi. Ditunda karena butuh mekanisme keamanan tambahan yang belum digarap.
