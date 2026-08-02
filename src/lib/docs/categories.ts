// Konstanta murni, tanpa import Node API — file ini boleh diimpor dari
// Client Component (mis. landing page /docs). Operasi baca file server-only
// hidup terpisah di fs.ts, biar gak ketarik ke client bundle.

export type DocCategoryId = "domain" | "architecture" | "story";

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
    id: "story",
    label: "Story",
    description:
      "Skenario bisnis CV Roti Barokah — data nyata yang dipakai buat simulasi tiap fase.",
  },
];

export function isValidCategory(value: string): value is DocCategoryId {
  return DOC_CATEGORIES.some((c) => c.id === value);
}

export type DocSummary = { slug: string; title: string };

export type DocTreeCategory = {
  category: DocCategoryId;
  label: string;
  docs: DocSummary[];
};
