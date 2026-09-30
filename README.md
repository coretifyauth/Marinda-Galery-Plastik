# custom-erp

ERP scaffold (Next.js App Router + TypeScript + Supabase). Dipakai sebagai [GitHub template repo](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template) — baru? Baca [TEMPLATE.md](TEMPLATE.md) dulu buat langkah setup + customize ke bisnis kamu.

## Supabase

```bash
npx supabase login
npx supabase link --project-ref <project-ref-kamu>
npx supabase db push
```

`<project-ref-kamu>` didapat dari dashboard Supabase project baru kamu sendiri (Settings > General > Reference ID) — jangan pakai project ref repo asal.