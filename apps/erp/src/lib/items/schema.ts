import { z } from "zod";

export const itemTypes = ["RAW_MATERIAL", "FINISHED_GOOD"] as const;

export const createItemSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  item_type: z.enum(itemTypes),
  uom: z.string().min(1, "Satuan wajib diisi"),
  inventory_account_id: z.string().uuid("Pilih akun persediaan"),
  category_id: z.string().uuid().nullable().optional(),
  brand_id: z.string().uuid().nullable().optional(),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;

// Fitur edit item (baru, sebelumnya field-field ini cuma bisa diisi sekali pas create)
// -- category_id/brand_id opsional, sisanya sama wajibnya kayak createItemSchema.
export const updateItemSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  item_type: z.enum(itemTypes),
  uom: z.string().min(1, "Satuan wajib diisi"),
  inventory_account_id: z.string().uuid("Pilih akun persediaan"),
  category_id: z.string().uuid().nullable(),
  brand_id: z.string().uuid().nullable(),
});

export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export type Item = {
  id: string;
  name: string;
  item_type: (typeof itemTypes)[number];
  uom: string;
  inventory_account_id: string;
  category_id: string | null;
  brand_id: string | null;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  /** Kode scan level barang (opsional) -- cuma di-select halaman detail item. */
  barcode?: string | null;
};
