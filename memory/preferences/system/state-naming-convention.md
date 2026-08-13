# State Naming Convention

Berlaku ke semua modul (COA, Journal Entry, AR, AP, dst), bukan cuma satu tabel.

## Dua state, dua makna beda — jangan dicampur

**`archived`** (kolom `archived_at timestamptz nullable`)
- Fungsi: nyimpen state "gak dipakai lagi" secara reversibel. `archived_at` di-null-kan lagi kalau mau diaktifkan ulang.
- Gak butuh field `is_active` terpisah — aktif = `archived_at IS NULL`. Nyimpen 2 kolom buat 1 kondisi = redundan, resiko gak sinkron.
- **Bukan lagi satu-satunya cara "menghapus" record** (revisi 2026-08-12, lihat "Smart Delete" di bawah) — tapi tetap satu-satunya cara buat record yang PERNAH dipakai di tempat lain, karena hard-delete beneran cuma aman kalau gak ada apa pun yang masih nunjuk ke situ.

## Smart Delete (master data): hard delete kalau belum pernah dipakai, arsip kalau udah

Berlaku ke `items`/`customers`/`suppliers`/`accounts` (master data yang punya tombol "Hapus" di UI-nya) — **bukan** ke tabel transaksional (`ap_bills`/`ar_invoices`/`journal_entries`/dst tetap immutable total, gak pernah bisa dihapus/diubah sama sekali, beda kasus).

- Kalau record itu belum pernah direferensikan di tabel lain mana pun (dicek lewat percobaan `DELETE` beneran + tangkap `foreign_key_violation` dari Postgres sendiri, bukan enumerasi manual) → **dihapus permanen** dari DB.
- Kalau udah pernah direferensikan (ada transaksi/riwayat yang nunjuk ke situ) → **diarsipkan** (`archived_at = now()`) sebagai fallback, bukan ditolak/gagal.
- Mekanisme lengkap (RPC `delete_item`/`delete_customer`/`delete_supplier`/`delete_account`, kenapa gak perlu enumerasi tabel referensi manual, 2 bug yang ketemu & diperbaiki pas dibangun): `memory/architecture/data/coa-schema.md` submodule "Smart Delete Master Data".
- Kebijakan LAMA (sebelum ini) sengaja nutup total hard-delete lewat RLS default-deny di keempat tabel ini ("cegah hard delete" — kalimat itu sekarang gak berlaku lagi apa adanya, direvisi lewat diskusi sama user). RLS-nya sendiri gak berubah (tetap gak ada grant/policy `DELETE` langsung ke tabel) — yang baru adalah 1 RPC `security definer` per entity yang jadi pintu sempit terkontrol buat kasus "belum pernah dipakai".

**`published`** (bukan kolom tersimpan — derived state)
- Fungsi: nyatain komitmen terhadap data. Begitu suatu record dipakai/direferensikan transaksi riil, dia dianggap "published" dan field-field kritikalnya (yang nentuin makna histori) terkunci.
- **Dilarang jadi field manual/toggle.** Kalau "published" bisa dipencet orang kapan aja, dia gak lagi merepresentasikan komitmen data — cuma jadi status UI biasa. Harus derived dari fakta objektif (`EXISTS` referensi di tabel transaksi), dicek pakai DB trigger, bukan app-level flag.
- Contoh di `accounts`: begitu akun dipakai di `journal_lines`, field `code`/`category`/`normal_balance`/`parent_id` terkunci — itu "published" state akun tsb, walau gak ada kolom `published` di tabel.

## Kenapa dipisah, bukan digabung jadi satu status enum

`archived` = soal lifecycle (masih dipakai atau tidak). `published` = soal integritas histori (boleh diedit atau tidak). Dua sumbu independen — akun bisa "published" (udah punya transaksi) TAPI belum "archived" (masih aktif dipakai terus). Gabung jadi satu status field bikin salah satu makna ke-collapse.

## Terapkan ke modul baru

Tiap desain tabel baru, tanya: (1) butuh soft-delete? → `archived_at`. (2) ada state "terkunci karena udah dipakai/dikomit"? → derived check + DB trigger, jangan bikin kolom manual.
