import { z } from "zod";

export const purchaseWriteoffLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty: z.coerce.number().positive("Qty write-off harus lebih dari 0"),
});

/**
 * Opsi C (Tulis-jadi-Beban) — mirror createPurchaseReplacementSchema (Opsi B) di
 * purchase-replacements/schema.ts. SELALU full-jalur (bill wajib punya
 * goods_receipt_notes). Beda dari Opsi B: 2 akun terpisah (loss_expense_account_id/
 * inventory_account_id), bukan 1 akun dipakai dua kali — jurnalnya bukan net-nol.
 */
export const createPurchaseWriteoffSchema = z.object({
  bill_id: z.string().uuid("Pilih bill"),
  writeoff_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  lines: z.array(purchaseWriteoffLineSchema).min(1, "Isi minimal 1 baris item"),
  loss_expense_account_id: z.string().uuid("Pilih akun Beban Kerugian Barang Rusak"),
  inventory_account_id: z.string().uuid("Pilih akun Persediaan"),
});

export type CreatePurchaseWriteoffInput = z.infer<typeof createPurchaseWriteoffSchema>;

export type PurchaseWriteoff = {
  id: string;
  bill_id: string;
  writeoff_date: string;
  source_ref: string;
  created_at: string;
  purchase_writeoff_lines: {
    item_id: string;
    qty_written_off: number;
    total_cost: number;
    items: { name: string; uom: string };
  }[];
};
