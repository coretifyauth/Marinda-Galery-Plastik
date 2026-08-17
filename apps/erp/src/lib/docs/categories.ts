// Konstanta murni, tanpa import Node API — file ini boleh diimpor dari
// Client Component (mis. landing page /docs). Operasi baca file server-only
// hidup terpisah di fs.ts, biar gak ketarik ke client bundle.

export type DocCategoryId = "domain" | "architecture" | "tutorial";

// Kategori yang isinya flat (1 level: docs/<category>/<slug>.md) vs yang
// disegmentasi per modul (2 level: docs/<category>/<module>/<slug>.md).
// Cuma "tutorial" yang grouped -- domain/architecture sengaja tetap flat
// (1 file per modul, gak butuh sub-grouping lagi).
export type GroupedCategoryId = "tutorial";

export function isGroupedCategory(id: DocCategoryId): id is GroupedCategoryId {
  return id === "tutorial";
}

export type DocCategory = {
  id: DocCategoryId;
  label: string;
  description: string;
};

export const DOC_CATEGORIES: DocCategory[] = [
  {
    id: "domain",
    label: "Domain Knowledge",
    description:
      "Konsep bisnis & akuntansi tiap modul — kenapa aturannya begitu, contoh angka, kesalahan umum.",
  },
  {
    id: "architecture",
    label: "Architecture",
    description:
      "Struktur data (ERD) tiap modul, dijelaskan non-teknis — entity, relasi, aturan otomatis.",
  },
  {
    id: "tutorial",
    label: "Tutorial",
    description:
      "User guide operasional per task — klik di mana, isi apa, buat menjalankan tiap alur kerja di aplikasi.",
  },
];

export function isValidCategory(value: string): value is DocCategoryId {
  return DOC_CATEGORIES.some((c) => c.id === value);
}

export type DocSummary = { slug: string; title: string };

export type DocModule = { id: string; label: string; docs: DocSummary[] };

// Discriminated union -- kategori flat (domain/architecture) bawa `docs`
// langsung, kategori grouped (tutorial) bawa `modules`. Komponen (doc-explorer,
// landing page kategori) switch di `kind`, gak perlu tau daftar kategori mana
// yang grouped secara hardcoded di tiap tempat.
export type DocTreeCategory =
  | { category: DocCategoryId; label: string; kind: "flat"; docs: DocSummary[] }
  | { category: GroupedCategoryId; label: string; kind: "grouped"; modules: DocModule[] };
