// created_by di tabel master data (items/item_units/item_categories/item_brands/
// counterparties/accounts/bom_headers/bom_lines) adalah email snapshot yang nullable --
// NULL berarti baris lama (dibuat sebelum kolom created_by ada) atau insert di luar jalur aplikasi,
// bukan error. Helper ini nyeragamin cara nampilinnya di semua detail page.
export function formatCreatedBy(createdBy: string | null, createdAt: string): string {
  const date = new Date(createdAt).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return createdBy ? `${createdBy} — ${date}` : `Data lama — ${date}`;
}
