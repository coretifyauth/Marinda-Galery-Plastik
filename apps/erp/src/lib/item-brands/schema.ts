import { z } from "zod";

// Katalog brand/merek barang -- pola sama item-categories, murni pengelompokan/filter di UI.
export const createItemBrandSchema = z.object({
  name: z.string().min(1, "Nama brand wajib diisi"),
});

export type CreateItemBrandInput = z.infer<typeof createItemBrandSchema>;

export type ItemBrand = {
  id: string;
  name: string;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
};
