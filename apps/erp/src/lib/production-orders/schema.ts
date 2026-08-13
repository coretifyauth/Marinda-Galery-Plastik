import { z } from "zod";

export const createProductionOrderSchema = z.object({
  bom_header_id: z.string().uuid("Pilih resep (BOM)"),
  qty_produced: z.coerce.number().positive("Qty produksi harus lebih dari 0"),
  production_date: z.string().min(1, "Tanggal wajib diisi"),
  finished_good_debit_account_id: z.string().uuid("Pilih akun Persediaan Barang Jadi"),
  raw_material_credit_account_id: z.string().uuid("Pilih akun Persediaan Bahan Baku"),
});

export type CreateProductionOrderInput = z.infer<typeof createProductionOrderSchema>;

export type ProductionOrder = {
  id: string;
  bom_header_id: string;
  qty_produced: number;
  production_date: string;
  source_ref: string;
  journal_entry_id: string;
  created_at: string;
  bom_headers: { items: { name: string } };
  production_order_lines: {
    id: string;
    item_id: string;
    qty_consumed: number;
    total_cost: number;
    items: { name: string; uom: string };
  }[];
};
