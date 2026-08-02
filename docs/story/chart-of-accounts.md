# Story — Chart of Accounts: CV Roti Barokah

Fase 1. Konteks bisnis lengkap: `docs/story/company-profile.md`. Konsep COA: `docs/domain/chart-of-accounts.md`. Schema: `docs/architecture/coa-schema.md`.

## Daftar Akun Bu Nur

Ini COA nyata yang dipakai buat CV Roti Barokah, disusun dari kebutuhan bisnisnya (bukan template generik):

```
1000 Kas                              (header)
├── 1100 Kas Toko                     — laci kasir kios, cash/QRIS harian
└── 1200 Kas di Bank                  — rekening operasional
1300 Piutang Usaha                    — tagihan ke 3 warung langganan
1400 Persediaan Bahan Baku            — tepung, gula, mentega, dst
1600 Aset Tetap                       (header)
├── 1610 Peralatan Oven
└── 1620 Kendaraan Motor              — motor antar ke warung

2100 Utang Usaha                      — utang ke 2 supplier tepung/gula
2200 Utang Bank                       — pinjaman KUR 2025

3100 Modal Pemilik
3200 Laba Ditahan

4100 Pendapatan Penjualan Toko        — jual langsung di kios
4200 Pendapatan Penjualan Grosir      — jual ke 3 warung langganan

5100 Harga Pokok Penjualan            — HPP roti terjual
5200 Beban Gaji Karyawan
5300 Beban Sewa Toko
5400 Beban Listrik dan Air
5500 Beban Bunga Bank                 — bunga cicilan KUR
```

**Kenapa dipisah gini:**
- `1000 Kas` jadi header karena Bu Nur butuh 2 kebutuhan beda: tau kas fisik di laci kios (buat rekonsiliasi harian sama kasir) vs saldo bank (buat transfer/cek pinjaman) — tapi direksi/Bu Nur sendiri kadang cuma mau tau "kas total berapa", makanya di-rollup ke `1000`.
- `4100` vs `4200` dipisah karena marginnya beda — jual di kios harga normal, jual grosir ke warung ada potongan harga. Bu Nur perlu tau mana yang lebih untung.
- **Sengaja gak** dibikin akun kas per-cabang atau per-hari — itu common mistake over-granular yang disebut di `docs/domain/chart-of-accounts.md`. Kalau nanti kios nambah, cukup tambah dimensi lain (bukan akun baru).
- **Belum ada** akun "Akumulasi Penyusutan" untuk oven/motor — itu bagian modul Fixed Assets (fase 6), sengaja ditunda karena butuh desain contra-asset yang belum dicover di schema `normal_balance` generated column sekarang (asset selalu debit; akun kontra-asset butuh perlakuan khusus, bukan celah yang perlu ditutup di fase 1).

Data ini beneran diinsert ke Supabase project kamu lewat `supabase/migrations/0003_seed_demo_coa.sql` — bukan cuma cerita di atas kertas, tapi data yang nempel di database asli dan bakal dipakai lagi pas fase Journal Entry (transaksi jual-beli roti bakal posting ke akun-akun ini).

## Simulasi Interface

Web app-nya sendiri sudah ada (`/login`, `/signup`, `/accounts` — lihat `src/app/`), tapi buat ngerasain lapisan RLS/grant secara eksplisit (bukan cuma "berhasil/gagal" di form), langkah di bawah masih pakai **Supabase Studio** (dashboard project kamu) + **curl ke REST API** langsung. Cara paling gampang buat punya akun sekarang: buka `/signup` di web app, isi email+password — gak perlu curl lagi buat langkah 4b.

### Langkah 1 — Jalankan seed data

Sudah dijalankan otomatis lewat `npx supabase db push` (migration `0003`). Kalau belum, jalankan itu dulu di terminal kamu.

### Langkah 2 — Lihat hasilnya kayak user beneran

Buka Supabase Studio (dashboard project kamu) → **Table Editor** → tabel `accounts`. Urutkan by `code`. Perhatikan:
- Kolom `normal_balance` **udah keisi otomatis** (debit/credit) — kamu gak pernah input itu manual, itu generated column dari `category`. Coba klik salah satu baris `liability`/`equity`/`revenue`, lihat semua otomatis `credit`.
- Kolom `parent_id` di baris `1100`/`1200`/`1610`/`1620` nunjuk ke `id` baris `1000`/`1600` — itu yang bikin hierarki jalan tanpa perlu kolom "level" terpisah.

### Langkah 3 — Coba "salah kategori" (common mistake) secara sengaja

Di Table Editor, insert 1 baris percobaan: `code='9999'`, `name='Utang Coba-coba'`, `category='asset'` (padahal namanya kedengeran kayak utang/liability). Perhatikan: **sistem tetap nerima**, `normal_balance` keisi `debit` (ngikut category asset). Ini bukti nyata dari common mistake di domain doc — DB cuma jamin `normal_balance` konsisten sama `category`, tapi gak bisa cegah manusia salah pilih category dari sisi makna bisnisnya. Itu tanggung jawab proses/training user, bukan constraint DB. Habis dicoba, hapus lagi baris ini (`delete` di Table Editor) — dia cuma buat latihan, bukan bagian story asli.

### Langkah 4 — Rasain RLS kayak app beneran (lewat curl)

Ganti `<ANON_KEY>` dan `<PROJECT_URL>` pakai punya kamu sendiri (ada di `.env.local`).

**4a. Coba baca tanpa login (anon) — harus ketolak:**
```bash
curl -s "<PROJECT_URL>/rest/v1/accounts?select=code,name" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
```
Ini bakal `permission denied` — sesuai desain, `accounts_select` policy nolak yang belum login.

**4b. Bikin 1 user test (misal karyawan admin Bu Nur), lalu login dapetin token:**

Cara termudah: daftar lewat `/signup` di web app (`admin@rotibarokah.test` / password bebas min. 6 karakter). Kalau mau ambil `access_token`-nya buat curl di langkah berikutnya, login lewat REST langsung:
```bash
curl -s "<PROJECT_URL>/auth/v1/token?grant_type=password" \
  -H "apikey: <ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"email":"admin@rotibarokah.test","password":"TestPass123!"}'
```
(Atau kalau mau tetap murni curl tanpa web app, daftar dulu lewat `<PROJECT_URL>/auth/v1/signup` dengan body JSON yang sama sebelum login.)

**4c. Baca `accounts` pakai `access_token` dari langkah 4b (bukan anon key lagi) — sekarang harus berhasil:**
```bash
curl -s "<PROJECT_URL>/rest/v1/accounts?select=code,name" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ACCESS_TOKEN>"
```
Berhasil, karena user ini sudah `authenticated` (walau belum punya role apa-apa) — sesuai desain, `accounts_select` emang dibuka buat semua yang login.

**4d. Coba insert akun baru pakai user ini — harus ketolak (belum ada role):**
```bash
curl -s "<PROJECT_URL>/rest/v1/accounts" -X POST \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"code":"9998","name":"Test Insert","category":"asset"}'
```
Ketolak — `accounts_insert` butuh role `admin`/`accountant` di `user_roles`, user ini belum ada di situ.

**4e. Kasih role `accountant` ke user ini** (lewat SQL Editor di Supabase Studio, bukan API — karena `user_roles` sengaja belum ada policy insert dari client):
```sql
insert into user_roles (user_id, role_name)
select id, 'accountant' from auth.users where email = 'admin@rotibarokah.test';
```

**4f. Ulangi langkah 4d** — sekarang harusnya berhasil (201), karena RLS ngecek ulang dan user ini sekarang match `role_name in ('admin','accountant')`.

Ini nunjukin end-to-end: schema, RLS, sama grant yang kita bangun kemarin beneran nyambung dan jalan kayak yang dirancang — bukan cuma lolos migration doang.

## Lanjutan Story

Fase berikutnya (General Ledger + Journal Entries) bakal nulis transaksi pertama Bu Nur (jual roti hari ini, beli tepung minggu ini) yang posting ke akun-akun di atas. File barunya: `docs/story/general-ledger.md` (dibuat pas fase itu mulai).
