import { z } from "zod";

export const bomLineSchema = z.object({
  raw_material_item_id: z.string().uuid("Pilih bahan baku"),
  qty_per_batch: z.coerce.number().positive("Qty harus lebih dari 0"),
});

export const createBomSchema = z.object({
  finished_item_id: z.string().uuid("Pilih barang jadi"),
  output_qty: z.coerce.number().positive("Output qty harus lebih dari 0"),
  lines: z.array(bomLineSchema).min(1, "Minimal 1 bahan baku"),
});

export type CreateBomInput = z.infer<typeof createBomSchema>;

export type BomHeader = {
  id: string;
  finished_item_id: string;
  output_qty: number;
  is_active: boolean;
  created_at: string;
  items: { name: string; uom: string };
  bom_lines: {
    id: string;
    raw_material_item_id: string;
    qty_per_batch: number;
    items: { name: string; uom: string };
  }[];
};
