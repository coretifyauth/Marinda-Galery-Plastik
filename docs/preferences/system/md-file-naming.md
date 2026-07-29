# MD File Naming

Semua file `.md` di `/docs` (dan subfoldernya) pakai nama deskriptif kebab-case, **tanpa prefix nomor** (`NN-`).

Contoh benar: `chart-of-accounts.md`, `tech-stack-decisions.md`, `coa-schema.md`.
Contoh salah: `01-chart-of-accounts.md`, `02-coa-schema.md`.

**Kenapa:** nomor urut gampang basi begitu ada file disisip di tengah atau direorganisasi (contoh: `preferences/system/`, `architecture/app/` baru dibuat, nomor lama jadi gak nyambung urutan). Nama deskriptif tetap valid dipindah/ditambah kapan pun. Urutan fase pembangunan (kalau perlu dirujuk) cukup dilihat dari Domain Roadmap di `AGENT.md`, bukan dari nomor filename.

Berlaku ke file baru maupun rename file lama tiap ketemu.
