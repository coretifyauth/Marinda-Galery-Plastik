import { z } from "zod";

export const poLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty_ordered: z.coerce.number().positive("Qty harus lebih dari 0"),
  unit_cost_expected: z.coerce.number().positive("Harga harus lebih dari 0"),
});

export const createPurchaseOrderSchema = z.object({
  supplier_id: z.string().uuid("Pilih supplier"),
  po_date: z.string().min(1, "Tanggal wajib diisi"),
  expected_date: z.string().optional(),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
  lines: z.array(poLineSchema).min(1, "Minimal 1 baris item"),
});

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

export type PurchaseOrderLine = {
  id: string;
  item_id: string;
  qty_ordered: number;
  unit_cost_expected: number;
  items: { name: string; uom: string };
  goods_receipt_lines: { qty_received: number }[];
};

export type PurchaseOrder = {
  id: string;
  supplier_id: string;
  po_date: string;
  expected_date: string | null;
  source_ref: string;
  created_at: string;
  suppliers: { name: string };
  purchase_order_lines: PurchaseOrderLine[];
};

export type PoStatus = "OPEN" | "PARTIALLY_RECEIVED" | "FULLY_RECEIVED";

/** Status derived dari SUM(goods_receipt_lines.qty_received) per line vs qty_ordered — bukan kolom, ref inventory-schema.md. */
export function poStatus(po: Pick<PurchaseOrder, "purchase_order_lines">): PoStatus {
  const totals = po.purchase_order_lines.map((line) => ({
    ordered: line.qty_ordered,
    received: line.goods_receipt_lines.reduce((sum, r) => sum + r.qty_received, 0),
  }));
  const allReceived = totals.every((t) => t.received >= t.ordered - 0.0005);
  const noneReceived = totals.every((t) => t.received <= 0.0005);
  if (allReceived) return "FULLY_RECEIVED";
  if (noneReceived) return "OPEN";
  return "PARTIALLY_RECEIVED";
}

export function lineRemaining(line: Pick<PurchaseOrderLine, "qty_ordered" | "goods_receipt_lines">): number {
  const received = line.goods_receipt_lines.reduce((sum, r) => sum + r.qty_received, 0);
  return Math.max(0, line.qty_ordered - received);
}
