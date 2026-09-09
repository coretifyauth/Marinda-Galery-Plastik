import { z } from "zod";

// Satuan jual per item (Multi Unit of Measure). Baris is_base=true wajib
// conversion_factor=1 dan unit_label sama persis items.uom (konvensi input,
// dijaga di UI — bukan trigger cross-table, lihat docs/domain/inventory.md).
export const createItemUnitSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  unit_label: z.string().min(1, "Nama satuan wajib diisi"),
  conversion_factor: z.coerce.number().positive("Faktor konversi harus lebih dari 0"),
  price: z.coerce.number().min(0, "Harga gak boleh negatif").optional(),
  is_base: z.boolean(),
});

export type CreateItemUnitInput = z.infer<typeof createItemUnitSchema>;

export type ItemUnit = {
  id: string;
  item_id: string;
  unit_label: string;
  conversion_factor: number;
  price: number | null;
  is_base: boolean;
  barcode: string | null;
};
