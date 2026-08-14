import { z } from "zod";

export const soLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty_ordered: z.coerce.number().positive("Qty harus lebih dari 0"),
  unit_price: z.coerce.number().positive("Harga harus lebih dari 0"),
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
  goods_issue_lines: { qty_issued: number }[];
};

export type SalesOrder = {
  id: string;
  customer_id: string;
  so_date: string;
  expected_date: string | null;
  source_ref: string;
  created_at: string;
  cancelled_at: string | null;
  customers: { name: string };
  sales_order_lines: SalesOrderLine[];
};

export type SoStatus = "OPEN" | "PARTIALLY_FULFILLED" | "FULLY_FULFILLED" | "CANCELLED";

/**
 * Status derived: `cancelled_at` menang duluan (state terminal, lihat
 * cancel_sales_order di inventory-schema.md), baru dihitung dari
 * SUM(goods_issue_lines.qty_issued) per line vs qty_ordered.
 */
export function soStatus(so: Pick<SalesOrder, "sales_order_lines" | "cancelled_at">): SoStatus {
  if (so.cancelled_at) return "CANCELLED";
  const totals = so.sales_order_lines.map((line) => ({
    ordered: line.qty_ordered,
    issued: line.goods_issue_lines.reduce((sum, r) => sum + r.qty_issued, 0),
  }));
  const allIssued = totals.every((t) => t.issued >= t.ordered - 0.0005);
  const noneIssued = totals.every((t) => t.issued <= 0.0005);
  if (allIssued) return "FULLY_FULFILLED";
  if (noneIssued) return "OPEN";
  return "PARTIALLY_FULFILLED";
}

export function lineRemaining(line: Pick<SalesOrderLine, "qty_ordered" | "goods_issue_lines">): number {
  const issued = line.goods_issue_lines.reduce((sum, r) => sum + r.qty_issued, 0);
  return Math.max(0, line.qty_ordered - issued);
}
