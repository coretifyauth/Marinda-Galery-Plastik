import { z } from "zod";

export const purchaseReplacementLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty: z.coerce.number().positive("Qty tukar harus lebih dari 0"),
});

/**
 * Opsi B (Tukar Barang) — mirror createWarrantyReplacementSchema di
 * ar-warranty-replacements/schema.ts. SELALU full-jalur (bill wajib punya
 * goods_receipt_notes, gak ada variant financial-only — ref komentar RPC
 * create_replacement di 0027_replacements_schema.sql). `inventory_account_id` dikirim sebagai
 * p_debit_account_id DAN p_credit_account_id ke create_replacement (akun yang sama) — bukan 2
 * field terpisah.
 */
export const createPurchaseReplacementSchema = z.object({
  bill_id: z.string().uuid("Pilih bill"),
  replacement_date: z.string().min(1, "Tanggal wajib diisi"),
  lines: z.array(purchaseReplacementLineSchema).min(1, "Isi minimal 1 baris item"),
  inventory_account_id: z.string().uuid("Pilih akun Persediaan"),
});

export type CreatePurchaseReplacementInput = z.infer<typeof createPurchaseReplacementSchema>;

export type PurchaseReplacement = {
  id: string;
  bill_id: string;
  replacement_date: string;
  source_ref: string;
  created_at: string;
  replacement_lines: {
    item_id: string;
    qty_replaced: number;
    total_cost: number;
    items: { name: string; uom: string };
  }[];
};
