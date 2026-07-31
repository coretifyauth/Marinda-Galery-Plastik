import { z } from "zod";

export const grnLineSchema = z.object({
  po_line_id: z.string().uuid("Baris PO gak valid"),
  item_id: z.string().uuid("Item gak valid"),
  qty_received: z.coerce.number().positive("Qty harus lebih dari 0"),
  unit_cost: z.coerce.number().positive("Harga harus lebih dari 0"),
});

export const createGoodsReceiptSchema = z.object({
  purchase_order_id: z.string().uuid("Pilih purchase order"),
  receipt_date: z.string().min(1, "Tanggal wajib diisi"),
  delivery_note_ref: z.string().optional(),
  bill_description: z.string().optional(),
  bill_source_ref: z.string().min(1, "Rujukan dokumen bill wajib diisi"),
  debit_account_id: z.string().uuid("Pilih akun Persediaan"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
  lines: z.array(grnLineSchema).min(1, "Minimal 1 baris item"),
});

export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;

export type GoodsReceiptNote = {
  id: string;
  purchase_order_id: string;
  bill_id: string;
  delivery_note_ref: string | null;
  receipt_date: string;
  created_at: string;
  purchase_orders: { source_ref: string; suppliers: { name: string } };
  ap_bills: { source_ref: string; amount: number };
  goods_receipt_lines: {
    id: string;
    item_id: string;
    qty_received: number;
    unit_cost: number;
    items: { name: string; uom: string };
  }[];
};
