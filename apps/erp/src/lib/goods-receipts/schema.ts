import { z } from "zod";
import { chargeLineSchema } from "@/lib/charge-lines/schema";

export const grnLineSchema = z.object({
  po_line_id: z.string().uuid("Baris PO gak valid").optional(),
  item_id: z.string().uuid("Item gak valid"),
  qty_received: z.coerce.number().positive("Qty harus lebih dari 0"),
  unit_cost: z.coerce.number().positive("Harga harus lebih dari 0"),
});

export const createGoodsReceiptSchema = z
  .object({
    purchase_order_id: z.string().uuid("Pilih purchase order").optional(),
    supplier_id: z.string().uuid("Pilih supplier").optional(),
    receipt_date: z.string().min(1, "Tanggal wajib diisi"),
    delivery_note_ref: z.string().optional(),
    bill_description: z.string().optional(),
    debit_account_id: z.string().uuid("Pilih akun Persediaan"),
    payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
    lines: z.array(grnLineSchema).min(1, "Minimal 1 baris item"),
    extra_debit_lines: z.array(chargeLineSchema).optional(),
    apply_tax: z.boolean().default(false),
  })
  // Purchase Order opsional (memory/scope-debt/order-generalization.md Fase 2) -- tapi
  // begitu gak ada PO, supplier-nya harus dipilih manual, gak ada jalur lain buat tau siapa
  // yang ditagih.
  .refine((v) => !!v.purchase_order_id || !!v.supplier_id, {
    message: "Pilih Purchase Order, atau pilih supplier kalau terima barang langsung",
    path: ["supplier_id"],
  });

export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;

export type GoodsReceiptNote = {
  id: string;
  purchase_order_id: string | null;
  bill_id: string;
  delivery_note_ref: string | null;
  receipt_date: string;
  created_at: string;
  purchase_orders: { source_ref: string; counterparties: { name: string } } | null;
  ap_bills: { source_ref: string; amount: number; counterparties: { name: string } };
  goods_receipt_lines: {
    id: string;
    item_id: string;
    qty_received: number;
    unit_cost: number;
    items: { name: string; uom: string };
  }[];
};
