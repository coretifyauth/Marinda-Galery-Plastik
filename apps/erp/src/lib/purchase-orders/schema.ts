import { z } from "zod";

export const poLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty_ordered: z.coerce.number().positive("Qty harus lebih dari 0"),
  unit_price: z.coerce.number().positive("Harga harus lebih dari 0"),
});

export const createPurchaseOrderSchema = z.object({
  supplier_id: z.string().uuid("Pilih supplier"),
  po_date: z.string().min(1, "Tanggal wajib diisi"),
  expected_date: z.string().optional(),
  lines: z.array(poLineSchema).min(1, "Minimal 1 baris item"),
});

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

export type PurchaseOrderLine = {
  id: string;
  item_id: string;
  qty_ordered: number;
  unit_price: number;
  items: { name: string; uom: string };
  goods_note_lines: { qty: number }[];
};

export type PurchaseOrder = {
  id: string;
  counterparty_id: string;
  order_date: string;
  expected_date: string | null;
  source_ref: string;
  created_at: string;
  cancelled_at: string | null;
  counterparties: { name: string };
  order_lines: PurchaseOrderLine[];
};

export type PoStatus = "OPEN" | "PARTIALLY_RECEIVED" | "FULLY_RECEIVED" | "CANCELLED";

export type PurchaseOrderListRow = {
  id: string;
  counterparty_id: string;
  order_date: string;
  expected_date: string | null;
  source_ref: string;
  created_at: string;
  cancelled_at: string | null;
  status: PoStatus;
  counterparties: { name: string };
  order_lines: {
    id: string;
    item_id: string;
    qty_ordered: number;
    unit_price: number;
    items: { name: string; uom: string };
  }[];
};

/**
 * Status derived: `cancelled_at` menang duluan (state terminal, lihat
 * cancel_order di inventory-schema.md), baru dihitung dari
 * SUM(goods_note_lines.qty) per line vs qty_ordered.
 */
export function poStatus(po: Pick<PurchaseOrder, "order_lines" | "cancelled_at">): PoStatus {
  if (po.cancelled_at) return "CANCELLED";
  const totals = po.order_lines.map((line) => ({
    ordered: line.qty_ordered,
    received: line.goods_note_lines.reduce((sum, r) => sum + r.qty, 0),
  }));
  const allReceived = totals.every((t) => t.received >= t.ordered - 0.0005);
  const noneReceived = totals.every((t) => t.received <= 0.0005);
  if (allReceived) return "FULLY_RECEIVED";
  if (noneReceived) return "OPEN";
  return "PARTIALLY_RECEIVED";
}

export function lineRemaining(line: Pick<PurchaseOrderLine, "qty_ordered" | "goods_note_lines">): number {
  const received = line.goods_note_lines.reduce((sum, r) => sum + r.qty, 0);
  return Math.max(0, line.qty_ordered - received);
}
