import { z } from "zod";

export const creditNoteLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty_returned: z.coerce.number().positive("Qty retur harus lebih dari 0"),
  condition: z.enum(["RESALABLE", "DAMAGED"]).default("RESALABLE"),
});

export const createArCreditNoteSchema = z
  .object({
    invoice_id: z.string().uuid("Pilih invoice"),
    credit_note_date: z.string().min(1, "Tanggal wajib diisi"),
    source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
    amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
    contra_revenue_account_id: z.string().uuid("Pilih akun Retur & Potongan Penjualan"),
    receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
    lines: z.array(creditNoteLineSchema).default([]),
    hpp_account_id: z.string().uuid().optional(),
    finished_good_account_id: z.string().uuid().optional(),
    return_credit_liability_account_id: z.string().uuid().optional(),
    loss_expense_account_id: z.string().uuid().optional(),
  })
  .refine(
    (data) => data.lines.every((l) => l.condition !== "DAMAGED") || !!data.loss_expense_account_id,
    {
      message: "Pilih akun Beban Kerugian Barang Rusak — ada baris retur yang kondisinya Rusak",
      path: ["loss_expense_account_id"],
    }
  );

export type CreateArCreditNoteInput = z.infer<typeof createArCreditNoteSchema>;

export type ArCreditNote = {
  id: string;
  invoice_id: string;
  credit_note_date: string;
  source_ref: string;
  amount: number;
  created_at: string;
};

export type GoodsIssueForInvoice = {
  id: string;
  goods_issue_lines: {
    item_id: string;
    qty_issued: number;
    items: { name: string; uom: string };
  }[];
};
