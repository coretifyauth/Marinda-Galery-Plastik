import { z } from "zod";

export const soLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty_ordered: z.coerce.number().positive("Qty harus lebih dari 0"),
  unit_price: z.coerce.number().positive("Harga harus lebih dari 0"),
  discount_rule_id: z.string().uuid().optional(),
  discount_amount: z.coerce.number().nonnegative().optional(),
  bundle_promo_rule_id: z.string().uuid().optional(),
});

export const createSalesOrderSchema = z.object({
  customer_id: z.string().uuid("Pilih customer"),
  so_date: z.string().min(1, "Tanggal wajib diisi"),
  expected_date: z.string().optional(),
  lines: z.array(soLineSchema).min(1, "Minimal 1 baris item"),
});

export type CreateSalesOrderInput = z.infer<typeof createSalesOrderSchema>;

export type SalesOrderLine = {
  id: string;
  item_id: string;
  qty_ordered: number;
  unit_price: number;
  items: { name: string; uom: string };
  goods_note_lines: { qty: number }[];
};

export type SalesOrder = {
  id: string;
  counterparty_id: string;
  order_date: string;
  expected_date: string | null;
  source_ref: string;
  created_at: string;
  cancelled_at: string | null;
  counterparties: { name: string };
  order_lines: SalesOrderLine[];
};

export type SoStatus = "OPEN" | "PARTIALLY_FULFILLED" | "FULLY_FULFILLED" | "CANCELLED";

export type SalesOrderListRow = {
  id: string;
  counterparty_id: string;
  order_date: string;
  expected_date: string | null;
  source_ref: string;
  created_at: string;
  cancelled_at: string | null;
  status: SoStatus;
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
export function soStatus(so: Pick<SalesOrder, "order_lines" | "cancelled_at">): SoStatus {
  if (so.cancelled_at) return "CANCELLED";
  const totals = so.order_lines.map((line) => ({
    ordered: line.qty_ordered,
    issued: line.goods_note_lines.reduce((sum, r) => sum + r.qty, 0),
  }));
  const allIssued = totals.every((t) => t.issued >= t.ordered - 0.0005);
  const noneIssued = totals.every((t) => t.issued <= 0.0005);
  if (allIssued) return "FULLY_FULFILLED";
  if (noneIssued) return "OPEN";
  return "PARTIALLY_FULFILLED";
}

export function lineRemaining(line: Pick<SalesOrderLine, "qty_ordered" | "goods_note_lines">): number {
  const issued = line.goods_note_lines.reduce((sum, r) => sum + r.qty, 0);
  return Math.max(0, line.qty_ordered - issued);
}
