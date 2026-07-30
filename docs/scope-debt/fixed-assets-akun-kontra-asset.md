# Chart of Accounts — Akun Kontra-Asset (Akumulasi Penyusutan)

**Modul asal:** Chart of Accounts (Fase 1). **Status:** Ditunda ke Fase 6 (Fixed Assets).

## Kasus

Oven tambahan + motor (dibeli 2025 pakai KUR, `docs/story/company-profile.md`) perlu disusutkan (depresiasi) — nilai bukunya berkurang tiap periode, dicatat di akun **Akumulasi Penyusutan**. Akun ini secara akuntansi adalah **kontra-asset**: kategori asset, tapi saldo normalnya **kredit** (kebalikan dari asset biasa yang normal_balance-nya debit).

## Kenapa ditunda

`accounts.normal_balance` di `coa-schema.md` adalah **generated column** yang derive otomatis dari `category`: `asset`/`expense` → selalu `debit`, gak ada pengecualian. Akun kontra-asset butuh `category = asset` tapi `normal_balance = credit` — ini gak bisa direpresentasikan sama schema sekarang tanpa ubah logic generated column atau nambah flag "is_contra" yang mempengaruhi kalkulasi.

## Kapan perlu digarap

Fase 6 (Fixed Assets), begitu modul depresiasi mulai didesain. Perlu keputusan: ubah `normal_balance` jadi kolom biasa (bukan generated) dengan validasi terpisah, atau tambah kategori/flag baru yang di-exception-kan dari rule "asset selalu debit".

## Referensi

- `docs/story/chart-of-accounts.md` (baris soal akun Akumulasi Penyusutan yang belum ada)
- `docs/architecture/data/coa-schema.md` (`normal_balance` generated column)
