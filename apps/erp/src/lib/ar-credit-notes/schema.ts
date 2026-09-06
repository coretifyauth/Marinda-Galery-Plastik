import { z } from "zod";

export const creditNoteLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty_returned: z.coerce.number().positive("Qty retur harus lebih dari 0"),
});

export const createArCreditNoteSchema = z.object({
  invoice_id: z.string().uuid("Pilih invoice"),
  credit_note_date: z.string().min(1, "Tanggal wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  contra_revenue_account_id: z.string().uuid("Pilih akun Retur & Potongan Penjualan"),
  receivable_account_id: z.string().uuid("Pilih akun Piutang Usaha"),
  lines: z.array(creditNoteLineSchema).default([]),
  hpp_account_id: z.string().uuid().optional(),
  finished_good_account_id: z.string().uuid().optional(),
  return_credit_liability_account_id: z.string().uuid().optional(),
});

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
    // Cuma keisi kalau line ini fulfillment dari Sales Order -- itu satu-satunya tempat harga
    // jual per item ketracking (order_lines.unit_price). Jalur jual langsung (walk-in,
    // order_line_id null) gak punya harga per item di mana pun, invoice-nya cuma nyimpen total
    // lump-sum per kategori (ar_invoice_credit_lines) -- lihat docs/domain/print-templates.md
    // submodule "Harga Per Item".
    order_line_id?: string | null;
    order_lines?: { unit_price: number } | null;
  }[];
};
