import { z } from "zod";

export const warrantyReplacementLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty: z.coerce.number().positive("Qty ganti harus lebih dari 0"),
});

export const createWarrantyReplacementSchema = z.object({
  credit_note_id: z.string().uuid("Pilih credit note"),
  replacement_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  lines: z.array(warrantyReplacementLineSchema).min(1, "Isi minimal 1 baris item"),
  hpp_account_id: z.string().uuid("Pilih akun HPP"),
  finished_good_account_id: z.string().uuid("Pilih akun Persediaan Barang Jadi"),
  contra_revenue_account_id: z.string().uuid("Pilih akun Retur & Potongan Penjualan"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
});

export type CreateWarrantyReplacementInput = z.infer<typeof createWarrantyReplacementSchema>;

export type WarrantyReplacement = {
  id: string;
  credit_note_id: string;
  replacement_date: string;
  source_ref: string;
  created_at: string;
  discount_reversed_amount: number;
  warranty_replacement_lines: {
    item_id: string;
    qty_replaced: number;
    total_cost: number;
    items: { name: string; uom: string };
  }[];
};
