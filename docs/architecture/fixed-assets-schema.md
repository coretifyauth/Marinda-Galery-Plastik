# Fixed Assets — Struktur Data

Fase 6. Konsep bisnisnya ada di `docs/domain/fixed-assets.md`. Skenario nyata: `docs/story/fixed-assets.md`. Konsep akun kontra: `docs/domain/chart-of-accounts.md` bagian "Akun Kontra". Detail teknis: `memory/architecture/data/fixed-assets-schema.md`.

## Peta Data (ERD)

| Tabel | Fungsi | Terhubung ke |
|---|---|---|
| `fixed_assets` | Master data tiap unit aset tetap (1 baris = 1 oven, 1 motor, dst — bukan kategori) | Menunjuk ke 3 akun di Chart of Accounts sekaligus |
| `depreciation_entries` | Histori posting penyusutan, satu baris per periode per aset | `fixed_assets`, dan ke transaksi jurnal yang otomatis dibuat |

**Setiap aset tetap dipetakan ke 3 akun sekaligus di Chart of Accounts** (bukan cuma 1) — ini yang membuat modul ini beda dari modul lain:

| Peran akun | Contoh | Kenapa terpisah |
|---|---|---|
| Akun Aset | "Aset Tetap - Oven" | Menyimpan nilai perolehan asli, tidak pernah berubah sampai aset dijual/dibuang — supaya histori "beli berapa dulu" tetap bisa ditelusuri |
| Akun Akumulasi Penyusutan (kontra-asset) | "Akumulasi Penyusutan - Oven" | Menampung total penyusutan yang sudah berjalan, ditampilkan sebagai pengurang di Neraca — bukan langsung mengurangi akun Aset |
| Akun Beban Penyusutan | "Beban Penyusutan - Oven" | Muncul di Laporan Laba Rugi sebagai biaya operasional periode berjalan |

Sistem memvalidasi otomatis bahwa ketiga akun ini dipetakan sesuai perannya masing-masing (misalnya akun Akumulasi Penyusutan harus benar-benar berstatus akun kontra) — mencegah kesalahan pasang akun dari sisi tampilan.

**Struktur `fixed_assets` (kolom yang penting buat dipahami):**

| Kolom | Isinya | Catatan |
|---|---|---|
| nilai perolehan | Harga beli + biaya siap pakai | |
| nilai residu | Estimasi nilai jual di akhir umur manfaat | Sering Rp0 untuk aset UMKM kecil |
| umur manfaat | Berapa lama aset dipakai | Disimpan dalam bulan, supaya penyusutan bulanan presisi |
| metode penyusutan | Garis Lurus atau Saldo Menurun | Ditentukan **per aset**, bukan satu metode untuk semua |
| tarif penyusutan | Persentase per periode posting | Hanya diisi kalau metode Saldo Menurun; wajib kosong kalau Garis Lurus |

**Struktur `depreciation_entries`:** satu baris = satu periode penyusutan untuk satu aset, menyimpan jumlah penyusutan periode itu secara eksplisit (bukan dihitung ulang dari rumus setiap kali dibaca) — ini yang membuat metode Saldo Menurun (nilainya beda tiap periode) tidak butuh struktur data tambahan dibanding Garis Lurus.

## Aturan Otomatis yang Dijaga Sistem

1. **Total penyusutan tidak boleh melebihi batas.** Sistem menolak posting penyusutan yang membuat akumulasi melebihi `nilai perolehan - nilai residu` — aset tidak bisa "disusutkan" sampai bernilai negatif.
2. **Tidak boleh dobel posting periode yang sama untuk aset yang sama.**
3. **Penyusutan yang sudah diposting tidak pernah bisa diedit atau dihapus** — koreksi hanya lewat entry pembalik (reversing entry) lalu posting ulang, sama pola dengan modul lain.
4. **Aset yang sudah pernah disusutkan jadi "terkunci" sebagian.** Begitu sebuah aset punya minimal satu riwayat penyusutan, field penentu nilainya (nilai perolehan, nilai residu, umur manfaat, metode, tarif, dan ketiga akun yang dipetakan) tidak bisa diubah lagi — mencegah histori penyusutan yang sudah berjalan jadi tidak konsisten. Nama aset tetap boleh diganti kapan saja.
5. **Ketiga akun yang dipetakan ke sebuah aset divalidasi perannya** saat aset didaftarkan atau diubah (lihat tabel peran akun di atas).

## Cara Kerja "Daftarkan Aset" dan "Posting Penyusutan"

- **Daftarkan aset baru** — hanya menyimpan data master (nilai, umur manfaat, metode, akun-akun terkait). Transaksi jurnal akuisisi (Debit Aset Tetap, Kredit Kas/Utang) dicatat terpisah lewat transaksi jurnal biasa, karena itu kejadian umum yang tidak butuh proses khusus.
- **Posting penyusutan satu periode** — sistem menghitung jumlah penyusutan otomatis sesuai metode aset (Garis Lurus: rata setiap periode; Saldo Menurun: persentase dari nilai buku sisa), lalu membuat transaksi jurnal (Debit Beban Penyusutan, Kredit Akumulasi Penyusutan) dan mencatat riwayatnya — semua sebagai satu langkah gabungan. Kalau perhitungan otomatis akan melewati batas maksimum, sistem otomatis memotong jumlahnya supaya pas berhenti di nilai residu (biasanya terjadi di periode terakhir umur manfaat aset).

## Siapa Boleh Apa

| Aksi | Siapa boleh |
|---|---|
| Melihat daftar aset & riwayat penyusutan | Semua user yang sudah login |
| Mendaftarkan aset baru, mengubah data aset (sebelum ada penyusutan) | Role `admin` atau `accountant` |
| Memposting penyusutan | Role `admin` atau `accountant` |
| Mengedit/menghapus riwayat penyusutan | **Tidak ada seorang pun** |
| Menghapus aset secara permanen | **Tidak ada seorang pun** — hanya bisa diarsipkan |

## Belum Termasuk

- **Pelepasan aset (disposal)** — belum ada cara mencatat penjualan/pembuangan aset beserta laba-rugi dari pelepasannya.
- **Metode Unit Produksi** — metode penyusutan berdasarkan pemakaian aktual (misalnya jam mesin), butuh data pemakaian dari luar modul ini.
- **Revaluasi aset.**
- **Ganti metode penyusutan di tengah umur manfaat aset** — saat ini field metode terkunci begitu ada riwayat penyusutan, tapi belum ada proses resmi untuk mengganti metode dengan sengaja lewat jalur yang benar (misalnya karena ada revaluasi formal).
