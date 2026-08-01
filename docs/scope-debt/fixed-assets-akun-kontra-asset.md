# Chart of Accounts — Akun Kontra-Asset (Akumulasi Penyusutan)

**Modul asal:** Chart of Accounts (Fase 1). **Status:** Selesai — Opsi A diterapkan di migration `0014_fixed_assets_schema.sql`.

## Kasus

Oven tambahan + motor (dibeli 2025 pakai KUR, `docs/story/company-profile.md`) perlu disusutkan (depresiasi) — nilai bukunya berkurang tiap periode, dicatat di akun **Akumulasi Penyusutan**. Akun ini secara akuntansi adalah **kontra-asset**: kategori asset, tapi saldo normalnya **kredit** (kebalikan dari asset biasa yang normal_balance-nya debit).

## Kenapa ditunda

`accounts.normal_balance` di `coa-schema.md` adalah **generated column** yang derive otomatis dari `category`: `asset`/`expense` → selalu `debit`, gak ada pengecualian. Akun kontra-asset butuh `category = asset` tapi `normal_balance = credit` — ini gak bisa direpresentasikan sama schema sekarang tanpa ubah logic generated column atau nambah flag "is_contra" yang mempengaruhi kalkulasi.

## Keputusan (Fase 6)

**Opsi A dipilih**: tambah kolom `is_contra boolean not null default false` di `accounts`, `normal_balance` tetap generated column tapi rumusnya ikut flag ini:

```sql
is_contra boolean not null default false,
normal_balance balance_side generated always as (
  case
    when category in ('asset','expense') then
      case when is_contra then 'credit'::balance_side else 'debit'::balance_side end
    else
      case when is_contra then 'debit'::balance_side else 'credit'::balance_side end
  end
) stored,
```

Alasan pilih ini dibanding Opsi B (`normal_balance` jadi kolom manual + validasi terpisah): generated column tetap jaga invariant "kategori nentuin balance" otomatis lewat DB (alasan awal kenapa `normal_balance` di-generate sejak fase COA — nutup celah salah kategori). Flag `is_contra` bikin exception-nya eksplisit dan terbatas, bukan buka pintu input manual bebas yang bisa disalahgunakan buat akun non-kontra.

Konsekuensi tambahan: `published` field-lock di `accounts` (`coa-schema.md`, field yang dikunci setelah dipakai transaksi: `code`, `category`, `normal_balance`, `parent_id`) harus nambah `is_contra` ke daftar itu — begitu akun kepakai transaksi, gak boleh diubah dari kontra jadi non-kontra atau sebaliknya.

## Selesai

Migration `0014_fixed_assets_schema.sql` nulis `ALTER TABLE accounts ADD COLUMN is_contra` bareng skema `fixed_assets`+`depreciation_entries` sekali jalan — sudah diapply ke instance Supabase + UI dites.

## Referensi

- `docs/domain/human/chart-of-accounts.md` bagian "Akun Kontra" (konsep umum + status project)
- `docs/domain/human/fixed-assets.md` (kasus konkret Akumulasi Penyusutan)
- `docs/architecture/data/coa-schema.md` (`normal_balance` generated column, `published` field-lock)
