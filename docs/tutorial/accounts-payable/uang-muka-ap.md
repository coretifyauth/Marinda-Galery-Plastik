# Bayar & Kelola Uang Muka (DP) ke Supplier

## Kapan Melakukan Ini

Saat perusahaan membayar sebagian di muka ke supplier sebelum bill-nya ada (mis. DP pemesanan bahan baku). DP yang sudah dibayar nanti punya 3 kemungkinan disposisi: diterapkan ke bill yang muncul belakangan, direfund tunai oleh supplier, atau dihanguskan (rugi kalau supplier tidak mau/bisa mengembalikan).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Supplier-nya sudah ada — kalau belum, buat dulu lewat [tambah-supplier-baru.md](tambah-supplier-baru.md).

## Langkah-Langkah

### 1. Bayar DP

1. Buka menu **AP Deposits** (`/ap-deposits`), klik **+ New**.
2. Isi **Supplier**, **Tanggal**, **Jumlah**, pilih metode **Akun Kas/Bank**.
3. Klik **Simpan**.

### 2a. Terapkan DP ke bill yang sudah ada

1. Buka detail bill (`/ap-bills/[id]`) yang mau dikurangi pakai DP ini.
2. Klik tombol **Terapkan DP** — ini reklasifikasi uang muka jadi pengurang utang, bukan pembayaran baru.
3. Pilih **Deposit** dari dropdown, **Nominal Diterapkan** otomatis terisi (sisa deposit atau outstanding bill, mana yang lebih kecil).
4. Isi **Tanggal**, klik **Terapkan DP**.

### 2b. Refund tunai sisa DP (supplier mengembalikan)

1. Buka detail deposit (`/ap-deposits/[id]`), tab **Refund Tunai**, klik tombol refund.
2. Isi **Nominal Refund** (maks sisa deposit), **Tanggal**, pilih metode **Akun Kas/Bank**.
3. Klik **Refund**.

### 2c. Hanguskan sisa DP (supplier tidak mau/bisa mengembalikan)

1. Buka detail deposit (`/ap-deposits/[id]`), tab **Hangus**, klik **Hanguskan**.
2. Isi **Nominal Hangus** (maks sisa deposit, boleh sebagian) dan **Tanggal**.
3. Klik **Hanguskan**.

## Hasil Akhir

- **Bayar DP**: jurnal debit Akun Uang Muka Pembelian (asset), kredit Kas/Bank.
- **Terapkan DP**: jurnal debit Utang Usaha, kredit Akun Uang Muka Pembelian — outstanding bill berkurang tanpa ada kas baru keluar.
- **Refund**: jurnal debit Kas/Bank, kredit Akun Uang Muka Pembelian — murni reklasifikasi aset.
- **Hangus**: jurnal debit **Akun Beban Kerugian Uang Muka**, kredit Akun Uang Muka Pembelian — ini **kerugian bagi kita** (beda arah dari sisi AR, di mana hangus DP customer jadi pendapatan bagi kita).

## Kesalahan Umum

- **Menyamakan makna "hangus" di AP dengan di AR** — di AR, DP customer yang hangus jadi pendapatan buat kita (customer yang rugi). Di AP, DP yang kita bayar ke supplier lalu hangus itu **kerugian buat kita** (kita yang rugi, bukan supplier).
- **Mengira "Terapkan DP" mengurangi kas lagi** — tidak, kasnya sudah keluar saat DP dibayar; menerapkan DP cuma memindahkan saldo dari Uang Muka Pembelian ke pengurang Utang Usaha.
