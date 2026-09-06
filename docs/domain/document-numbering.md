# Penomoran Dokumen Otomatis

## Masalah yang Diselesaikan

Selama ini, tiap dokumen transaksional (AP Bill, AR Invoice, Purchase Order, dan seterusnya) punya field "Rujukan Dokumen" yang diisi manual oleh user — bebas ketik apa saja. Ini punya beberapa masalah begitu bisnis makin besar dan jumlah transaksi makin banyak:

- **Bisa dobel tanpa sengaja** — dua bill beda bisa keketik nomor yang sama persis, sistem gak menolak.
- **Format gak konsisten** — user A ketik "INV-001", user B ketik "invoice 1", user C ketik tanggal doang. Susah dicari/diurutkan.
- **Gak kelihatan kalau ada yang "hilang"** — kalau nomornya manual, gak ada cara tahu apakah ada dokumen yang niatnya dibuat tapi gak jadi tersimpan.
- **Gak ada jejak audit otomatis** — nomor yang enak dibaca manusia dan berurutan itu bagian dari praktik akuntansi yang rapi, bukan sekadar kosmetik.

Solusinya: sistem yang menerbitkan nomornya sendiri, otomatis, begitu dokumen tersimpan — bukan diketik manual lagi.

## Konsep Inti

- Setiap jenis dokumen transaksional punya **Nomor Dokumen** resmi, format **`PREFIX-TAHUN-URUTAN`** (contoh: `APB-2026-00001`).
- Prefix beda-beda per jenis dokumen (`APB` untuk AP Bill, `ARI` untuk AR Invoice, dan seterusnya) — dari nomornya saja langsung ketahuan itu dokumen jenis apa.
- Urutannya **reset ke 1 setiap tanggal 1 Januari**, per jenis dokumen — jadi nomornya gak numpuk jadi puluhan ribu digit setelah bertahun-tahun sistem jalan, dan dari nomornya sendiri langsung kebaca tahun berapa transaksinya terjadi.
- Ini menggantikan field lama yang diisi manual — sekarang field itu murni hasil sistem, user gak bisa ketik atau ubah lagi.

### Dokumen Internal vs Dokumen Eksternal

**Cara Kerja**
- Hampir semua dokumen di sistem ini KITA yang menerbitkan sendiri (AR Invoice, Purchase Order, retur, dan seterusnya) — nomor otomatis pas jadi identitas resminya, karena memang belum ada nomor lain sebelumnya.
- Ada 1 pengecualian: **AP Bill** sebenarnya representasi dari **nota/faktur yang diterbitkan supplier**, bukan dokumen yang kita buat dari nol. Nota itu sudah py nomor sendiri dari pihak luar, yang gak bisa dan gak boleh digantikan oleh nomor otomatis kita.

**Aturan Bisnis**
- AP Bill tetap dapat Nomor Dokumen otomatis seperti dokumen lain — supaya konsisten dipakai sebagai referensi cepat di dalam sistem.
- Tapi nomor asli dari nota supplier direkam **terpisah**, di field khusus "Nomor Nota Supplier" (isi manual, opsional — gak semua transaksi py nota resmi). Dua nomor ini gak boleh saling menimpa; keduanya sama-sama harus tertelusuri.

**Skenario**
- User input AP Bill dari PT Plastindo Jaya. Nota fisiknya tertulis "SP-0451". Sistem otomatis kasih Nomor Dokumen `APB-2026-00007`, dan user isi "SP-0451" secara manual di field Nomor Nota Supplier.
- Kalau suatu saat perlu klarifikasi ke supplier soal tagihan tertentu, yang disebut ke supplier adalah nomor nota mereka ("SP-0451"), bukan `APB-2026-00007` — karena supplier gak kenal format penomoran internal kita.

**Common Mistakes**
- Mengira Nomor Dokumen otomatis = nomor resmi nota supplier. Dua-duanya beda dan harus direkam terpisah — kalau cuma nomor otomatis yang dicatat, rujukan balik ke nota fisik supplier hilang, melanggar prinsip "tiap transaksi harus tertelusuri ke dokumen sumber".

### Kapan Nomor Ditentukan

**Cara Kerja**
- Nomor **bukan** digenerate saat form "Tambah [Dokumen]" dibuka — kalau begitu, tiap kali user buka form lalu batal tanpa jadi simpan, nomor itu tetap "kepakai" padahal dokumennya gak pernah ada.
- Nomor digenerate **persis saat tombol Simpan diklik**, barengan proses penyimpanan data. Field ini sudah gak lagi muncul sebagai kotak isian di form sama sekali.

**Aturan Bisnis**
- Form create gak punya lagi input manual untuk nomor dokumen. Nomor final baru kelihatan di halaman detail setelah dokumen berhasil dibuat.

**Skenario**
- User isi form AR Invoice untuk Toko Kelontong Sumber Rejeki, klik Simpan → sistem generate nomor `ARI-2026-00012` barengan proses simpan → halaman detail invoice menampilkan nomor itu.

**Common Mistakes**
- Berharap bisa lihat/catat nomornya SEBELUM klik Simpan — gak bisa, karena nomor baru pasti ada setelah data beneran tersimpan. Konsekuensinya: kalau proses simpan gagal di tengah jalan (misal koneksi putus), nomor yang sempat digenerate bisa "hilang" tanpa pernah terpakai — ini disengaja, bukan bug, karena nomor ini murni referensi internal (bukan nomor resmi seperti Faktur Pajak yang diatur pemerintah), jadi celah semacam itu gak jadi masalah kepatuhan.

### Dokumen dengan Rujukan Manual Lama

**Cara Kerja**
- Sebagian dokumen di sistem masih menyimpan Rujukan Dokumen lama yang diketik manual (bukan format `PREFIX-TAHUN-URUTAN`) — isinya gak pernah diubah ke format baru.

**Aturan Bisnis**
- Sistem ini punya aturan "sekali dokumen tersimpan, gak pernah bisa diedit lagi — cuma bisa dibikin entry pembalik" (prinsip yang sama dengan jurnal akuntansi: transaksi yang sudah tercatat gak boleh dihapus/diubah diam-diam). Rujukan Dokumen ikut terkunci aturan ini juga, walau isinya cuma teks referensi, bukan angka uang.
- Konsekuensinya: dokumen dengan rujukan manual lama TETAP pakai rujukan itu selamanya — cuma dokumen yang dibuat dengan mekanisme penomoran otomatis ini yang dapat Nomor Dokumen otomatis.

**Skenario**
- AP Bill dengan rujukan manual lama masih tampil "Nota Beli #PJ-001" (isi manual). AP Bill lain yang dibuat lewat mekanisme penomoran otomatis dapat `APB-2026-00004`, dst.

**Common Mistakes**
- Mengira dokumen dengan rujukan manual lama otomatis "dirapikan" ke format baru. Gak — dokumen itu gak pernah disentuh karena aturan "gak bisa diedit" berlaku ke SEMUA kolom, termasuk Rujukan Dokumen.

## Glossary

- **Nomor Dokumen**: identitas resmi yang digenerate otomatis oleh sistem untuk tiap dokumen transaksional, format `PREFIX-TAHUN-URUTAN`.
- **Nomor Nota Supplier**: field khusus di AP Bill, isi nomor asli dari nota fisik yang diterbitkan supplier — terpisah dari Nomor Dokumen yang otomatis.
