# POS — Kemampuan Offline / Zero-Downtime

**Modul asal:** POS/Jualan Eceran (schema+RPC+UI checkout dasar sudah dibangun & di-deploy per 2026-08-09, `apps/pos` — lihat `memory/domain/pos.md`). **Status offline-capability ITU SENDIRI:** tetap Ditunda (keputusan final di bawah tetap berlaku — checkout tetap wajib online).

## Kasus

Owner pengin kasir POS tetap bisa transaksi walau internet putus/lambat — "zero-downtime" diajukan sebagai requirement awal pas planning modul POS, karena penjualan retail gak boleh berhenti cuma gara-gara masalah koneksi.

## Kenapa ditunda

Ini bentrok langsung sama aturan bisnis yang sudah diputuskan lebih dulu di Inventory (`memory/domain/inventory.md`): stok gak boleh oversell — kalau sistem bilang stok gak ada, transaksi gak boleh jalan, no exception. POS yang beneran offline-capable (local-first, cache stok di device, sync belakangan) berarti kasir jualan berdasarkan data stok yang bisa udah basi/gak sinkron sama kasir lain yang jual barang sama secara bersamaan saat offline — begitu online lagi, ada risiko oversell yang harus dikoreksi manual. Dua requirement ini saling mengunci: gak bisa pilih "selalu bisa transaksi apapun kondisinya" DAN "stok selalu akurat, no oversell" bersamaan tanpa kompromi salah satunya.

**Keputusan final:** pegang opsi (a) — stok selalu akurat, konsekuensinya kasir sempat gak bisa transaksi kalau internet mati. POS dibangun sebagai **modul terpisah sendiri** (bukan submodule di dalam AR, walau konsepnya "versi tunai" dari AR Invoice — alasannya dia gak pernah nyentuh Piutang Usaha sama sekali secara data, jadi berdiri sendiri).

**Update 2026-08-09 (soal wadah aplikasinya):** awalnya dipikir POS bakal hidup di aplikasi yang sama persis dengan admin/ERP (1 Next.js app, 1 deployment). Direvisi jadi **monorepo, 2 aplikasi Next.js terpisah** (`apps/erp` + `apps/pos`, detail rasional & impact: `memory/architecture/app/tech-stack-decisions.md` > "App Structure: Monorepo") — alasannya app POS perlu ramping (bundle kecil, load cepat) buat kasir, gak numpang di build admin yang berat, dan bisa dideploy/diakses independen. **Invariant inti gak berubah**: kedua app tetap konek real-time ke Supabase project yang SAMA (`inventory_balances` dst, 1 sumber kebenaran tunggal, gak ada cache stok lokal permanen di app POS) — yang dipisah cuma organisasi KODE/deployment, bukan datanya. Kalau datanya ikut dipisah, itu balik lagi jadi sumber risiko sync/oversell baru — persis yang mau dihindari sejak awal.

Kekhawatiran "lambat/downtime karena internet" ditangani lewat jalur non-arsitektur, di luar scope-debt ini: (1) kualitas engineering biasa (route ringan, prefetch katalog item/harga yang jarang berubah, minim round-trip ke server) — termasuk kemungkinan dibangun sebagai **PWA** (service worker cache buat UI shell + katalog item/harga yang statis, biar berasa cepat/app-like); (2) infrastruktur (internet cadangan/failover) — di luar scope software sama sekali. **Catatan penting soal PWA:** cache PWA cuma buat data yang jarang berubah (UI, katalog) — bagian checkout (cek stok + `create_pos_sale`) TETAP wajib online, karena itu titik yang butuh `inventory_balances` real-time. PWA mempercepat/memperhalus pengalaman, bukan cara buat lolos dari keputusan (a) di atas.

**Catatan jujur soal status PWA (2026-08-09):** build awal `apps/pos` (checkout dasar — katalog, keranjang, metode bayar, panggil `create_pos_sale`) SUDAH jalan, TAPI service worker/PWA caching-nya **belum** diimplementasikan — itu mitigasi kecepatan yang masih di luar scope build awal ini, bukan berarti udah otomatis kepasang begitu app-nya ada. Dibangun belakangan kalau kerasa kebutuhannya nyata di lapangan.

## Kapan perlu digarap

Kalau nanti muncul keluhan nyata di lapangan (bukan kekhawatiran di awal) soal internet sering putus dan itu beneran ganggu operasional kasir — baru direvisit. Revisit ini WAJIB bareng rediskusi kebijakan no-oversell di Inventory, karena dua keputusan itu terkait — gak bisa direvisit sepihak salah satunya doang.

## Referensi

- `memory/domain/inventory.md` (aturan anti over-consumption / no-oversell, fungsi `consume_weighted_average`)
- `memory/domain/accounts-receivable.md` (submodule "Credit Hold" — catatan "cash sale ke customer on-hold gak lewat `ar_invoices` sama sekali", cikal bakal pattern POS)
