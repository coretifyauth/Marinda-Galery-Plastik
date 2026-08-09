import { z } from "zod";

export const giLineSchema = z.object({
  item_id: z.string().uuid("Pilih barang jadi"),
  qty_issued: z.coerce.number().positive("Qty harus lebih dari 0"),
});

export const createGoodsIssueSchema = z.object({
  customer_id: z.string().uuid("Pilih customer"),
  invoice_date: z.string().min(1, "Tanggal wajib diisi"),
  description: z.string().optional(),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
  revenue_account_id: z.string().uuid("Pilih akun Pendapatan"),
  hpp_account_id: z.string().uuid("Pilih akun HPP"),
  finished_good_account_id: z.string().uuid("Pilih akun Persediaan Barang Jadi"),
  lines: z.array(giLineSchema).min(1, "Minimal 1 baris item"),
});

export type CreateGoodsIssueInput = z.infer<typeof createGoodsIssueSchema>;

export type GoodsIssue = {
  id: string;
  invoice_id: string;
  journal_entry_id: string;
  issue_date: string;
  source_ref: string;
  created_at: string;
  ar_invoices: { source_ref: string; amount: number; customers: { name: string } };
  goods_issue_lines: {
    id: string;
    item_id: string;
    qty_issued: number;
    total_cost: number;
    items: { name: string; uom: string };
  }[];
};
