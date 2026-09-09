import { z } from "zod";
import { chargeLineSchema } from "@/lib/charge-lines/schema";

export const giLineSchema = z.object({
  item_id: z.string().uuid("Pilih barang jadi"),
  qty_issued: z.coerce.number().positive("Qty harus lebih dari 0"),
  order_line_id: z.string().uuid().optional(),
});

export const createGoodsIssueSchema = z.object({
  customer_id: z.string().uuid("Pilih customer"),
  invoice_date: z.string().min(1, "Tanggal wajib diisi"),
  description: z.string().optional(),
  credit_lines: z.array(chargeLineSchema).min(1, "Minimal 1 baris kredit"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
  hpp_account_id: z.string().uuid("Pilih akun HPP"),
  finished_good_account_id: z.string().uuid("Pilih akun Persediaan Barang Jadi"),
  lines: z.array(giLineSchema).min(1, "Minimal 1 baris item"),
  apply_tax: z.boolean().default(false),
});

export type CreateGoodsIssueInput = z.infer<typeof createGoodsIssueSchema>;

export type GoodsIssue = {
  id: string;
  transaction_id: string;
  journal_entry_id: string;
  note_date: string;
  source_ref: string;
  created_at: string;
  ar_invoices: { source_ref: string; amount: number; counterparties: { name: string } };
  goods_note_lines: {
    id: string;
    item_id: string;
    qty: number;
    total_cost: number;
    order_line_id: string | null;
    items: { name: string; uom: string };
  }[];
};
