import { z } from "zod";

// Katalog kategori barang -- pola sama charge_categories, bedanya gak ada
// account_id (bukan konsep akuntansi, murni pengelompokan/filter di UI).
export const createItemCategorySchema = z.object({
  name: z.string().min(1, "Nama kategori wajib diisi"),
});

export type CreateItemCategoryInput = z.infer<typeof createItemCategorySchema>;

export type ItemCategory = {
  id: string;
  name: string;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
};
