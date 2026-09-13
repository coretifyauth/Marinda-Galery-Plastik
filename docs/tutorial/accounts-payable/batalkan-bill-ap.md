# Batalkan AP Bill

## Kapan Melakukan Ini

Saat bill yang dicatat ternyata salah total (mis. salah input, salah supplier) dan belum ada pembayaran sama sekali terhadapnya — bukan untuk kasus retur sebagian barang (itu pakai [retur-barang-ap.md](retur-barang-ap.md)).

## Prasyarat

- Login dengan role **admin** atau **accountant**.
- Bill ini **belum punya pembayaran sama sekali** — begitu ada pembayaran, tombol batalkan tidak akan tersedia.
- Bill ini **bukan berasal dari penerimaan barang (GRN)** — kalau barangnya sudah masuk stok, sistem menolak pembatalan langsung (lihat "Kesalahan Umum" di bawah).

## Langkah-Langkah

1. Buka detail bill (`/ap-bills/[id]`) yang mau dibatalkan.
2. Klik tombol **Batalkan** (cuma muncul kalau belum ada pembayaran).
3. Konfirmasi dialog yang muncul.

## Hasil Akhir

- Jurnal pembalik otomatis terbentuk, membalik seluruh efek jurnal bill ini — bill tetap ada sebagai record (ditandai dibatalkan), tidak dihapus.
- Status bill berubah jadi **dibatalkan** di daftar AP Bills.

## Kesalahan Umum

- **Mencari tombol Batalkan padahal bill sudah ada pembayaran** — untuk kasus ini, penyelesaiannya lewat retur ([retur-barang-ap.md](retur-barang-ap.md)), bukan pembatalan total.
- **Bill dari GRN yang mau dibatalkan** — sistem menolak: barang yang sudah masuk stok dari GRN tidak boleh "hilang" utangnya begitu saja lewat pembatalan biasa, karena stoknya tetap ada tapi kewajiban ke supplier & nilai persediaannya lenyap dari pembukuan. Solusinya pakai [retur-barang-ap.md](retur-barang-ap.md) — jalur itu membalik stok DAN jurnal/utang sekaligus.
