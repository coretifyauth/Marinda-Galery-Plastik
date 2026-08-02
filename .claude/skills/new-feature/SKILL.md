---
name: new-feature
description: Gerbang wajib sebelum membangun fitur/modul baru di custom-erp — memaksa business context, ERD, dan cek dampak dijelaskan dulu sebelum kode ditulis. Gunakan tiap kali diminta membangun fitur/modul baru, bukan untuk bugfix kecil di fitur yang sudah ada.
---

# New Feature Gate

Skill ini menegakkan proses wajib dari `AGENTS.md` ("Rules — proses wajib sebelum fitur baru") sebagai **hard gate**, bukan checklist yang bisa dilewat. Kalau user minta bikin fitur/modul baru (bukan bugfix/perbaikan kecil di fitur existing), JANGAN langsung ke kode — walau diminta cepat.

## Langkah wajib, urutan gak boleh dibalik

### 1. Business/domain context — jelaskan, ajarkan sampai paham, baru dokumentasikan

Ini bukan satu langkah, tapi 3 sub-langkah berurutan, gak boleh diloncat:

**1a. Jelaskan** masalah bisnis/akuntansi apa yang mau diselesaikan, sebelum menyebut satu pun nama tabel/kolom/kode. Kalau modul ini punya padanan konsep di modul lain yang sudah ada (misal fitur baru di AP mirip pola AR), sebut perbandingannya.

**1b. Ajarkan sampai user paham** — ikuti siklus "Cara Mengajar" penuh dari `AGENTS.md` (business context → accounting logic dengan contoh angka → common mistake). Ini interaktif, bukan monolog sekali jalan: gali balik pemahaman user, jawab pertanyaan "kenapa" dari sisi bisnis dulu, kasih contoh angka konkret. Jangan lanjut ke 1c sebelum user kelihatan paham (nanya balik hal yang relevan, bisa jelasin balik dengan kata sendiri, atau eksplisit bilang paham/lanjut).

**1c. Baru setelah user paham** — bukan sebelum, bukan bersamaan — tulis knowledge yang udah dibangun ke:
   - `docs/domain/<nama-modul>.md` (naratif, hasil dari pemahaman yang udah tercapai lewat diskusi — bukan draft yang ditulis duluan lalu "dijelasin" belakangan)
   - `memory/domain/<nama-modul>.md` (compact, padanan teknis)
   - `docs/story/<nama-modul>.md` (skenario bisnis konkret, lanjutan cerita perusahaan fiktif yang sudah berjalan — `docs/story/company-profile.md` + file story fase sebelumnya)

### 2. Rancang ERD

Gambarkan entity baru, relasi, FK, cardinality — secara eksplisit, sebelum nulis DDL. Kalau ini nambah kolom/tabel ke entity yang sudah ada (bukan entity baru), tetap sebutkan dampaknya ke ERD existing.

### 3. Cek kausalitas / dampak

Cek dan sebutkan eksplisit:
- Apakah ini berdampak ke modul/ERD yang sudah ada?
- Apakah ada trigger/RPC yang perlu di-reuse (pola project ini: RPC modul baru manggil RPC modul lama yang sudah ada — `create_journal_entry`, `create_ar_invoice`, `create_ap_bill`, dst — bukan insert manual ke tabel dasar)?
- Apakah ada Core Invariant (`AGENTS.md`) yang harus dijaga (balance debit=kredit, no edit posted period, traceability, money non-float)?

**Baru setelah 1 (a–c) sampai 3 eksplisit dijawab**, lanjut ke:

### 4. Schema -> API -> UI

Urutan ini gak boleh dibalik. Schema (migration SQL, ikuti `memory/preferences/system/schema-doc-format.md`) duluan, baru API route/RPC, baru UI. Sebelum bilang migration siap diapply, jalankan review lewat agent `schema-reviewer`.

## Kalau user menolak/minta skip

Kalau user secara eksplisit bilang "skip aja penjelasannya, langsung kode" — tetap jangan skip. Jawab singkat kenapa (ini aturan yang sudah disepakati di `AGENTS.md`: "Jangan skip penjelasan meski diminta cepat"), lalu tetap jalanin langkah 1(a–c)–3 secara ringkas sebelum lanjut kode. Ini satu-satunya rule di project ini yang sengaja gak bisa di-override on-the-fly dalam sesi — kalau user memang mau mengubah rule ini secara permanen, arahkan untuk mengubah `AGENTS.md` langsung, bukan minta di-skip diam-diam.

## Definisi "fitur/modul baru" vs yang gak butuh gate ini

**Butuh gate ini:** modul baru di Domain Roadmap (`AGENTS.md`), entity baru, RPC baru, perubahan constraint/invariant.

**Gak butuh gate penuh** (boleh langsung kerja, cukup sebut ringkas kontennya): bugfix, refactor UI tanpa ubah struktur data, perbaikan typo/copy, penyesuaian style.
