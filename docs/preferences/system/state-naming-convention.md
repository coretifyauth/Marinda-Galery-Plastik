# State Naming Convention

Berlaku ke semua modul (COA, Journal Entry, AR, AP, dst), bukan cuma satu tabel.

## Dua state, dua makna beda — jangan dicampur

**`archived`** (kolom `archived_at timestamptz nullable`)
- Fungsi: cegah hard delete. Data gak pernah beneran dihapus dari DB, cuma ditandai gak dipakai lagi.
- Bisa dibolak-balik: `archived_at` di-null-kan lagi kalau mau diaktifkan ulang.
- Gak butuh field `is_active` terpisah — aktif = `archived_at IS NULL`. Nyimpen 2 kolom buat 1 kondisi = redundan, resiko gak sinkron.

**`published`** (bukan kolom tersimpan — derived state)
- Fungsi: nyatain komitmen terhadap data. Begitu suatu record dipakai/direferensikan transaksi riil, dia dianggap "published" dan field-field kritikalnya (yang nentuin makna histori) terkunci.
- **Dilarang jadi field manual/toggle.** Kalau "published" bisa dipencet orang kapan aja, dia gak lagi merepresentasikan komitmen data — cuma jadi status UI biasa. Harus derived dari fakta objektif (`EXISTS` referensi di tabel transaksi), dicek pakai DB trigger, bukan app-level flag.
- Contoh di `accounts`: begitu akun dipakai di `journal_lines`, field `code`/`category`/`normal_balance`/`parent_id` terkunci — itu "published" state akun tsb, walau gak ada kolom `published` di tabel.

## Kenapa dipisah, bukan digabung jadi satu status enum

`archived` = soal lifecycle (masih dipakai atau tidak). `published` = soal integritas histori (boleh diedit atau tidak). Dua sumbu independen — akun bisa "published" (udah punya transaksi) TAPI belum "archived" (masih aktif dipakai terus). Gabung jadi satu status field bikin salah satu makna ke-collapse.

## Terapkan ke modul baru

Tiap desain tabel baru, tanya: (1) butuh soft-delete? → `archived_at`. (2) ada state "terkunci karena udah dipakai/dikomit"? → derived check + DB trigger, jangan bikin kolom manual.
