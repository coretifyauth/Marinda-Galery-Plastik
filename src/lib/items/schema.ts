import { z } from "zod";

export const itemTypes = ["RAW_MATERIAL", "FINISHED_GOOD"] as const;
export const costingMethods = ["FIFO", "WEIGHTED_AVERAGE"] as const;

export const createItemSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  item_type: z.enum(itemTypes),
  costing_method: z.enum(costingMethods),
  uom: z.string().min(1, "Satuan wajib diisi"),
  inventory_account_id: z.string().uuid("Pilih akun persediaan"),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;

export type Item = {
  id: string;
  name: string;
  item_type: (typeof itemTypes)[number];
  costing_method: (typeof costingMethods)[number];
  uom: string;
  inventory_account_id: string;
  archived_at: string | null;
};
