import { supabase } from "@/lib/supabase/client";
import { fromCents, toCents } from "./balances";

/** Satu baris mentah dari RPC `report_sales_purchase_monthly` (0066). */
export type SalesPurchaseRaw = {
  month: string; // YYYY-MM-01
  sales_goods: number;
  discount: number;
  sales_return: number;
  hpp: number;
  hpp_returned: number;
  purchases: number;
  purchase_return: number;
};

export type SalesPurchaseMonth = {
  month: string;
  grossSales: number; // sebelum diskon
  discount: number;
  salesReturn: number;
  netSales: number; // penjualan barang (setelah diskon) - retur
  hpp: number; // sudah dikurangi HPP retur
  grossProfit: number;
  marginPct: number | null; // null kalau penjualan bersih <= 0
  netPurchases: number; // barang masuk - retur ke supplier
};

// Uang dijumlah dalam sen (Core Invariant: money never float) -- pola sama dengan balances.ts.
const sub = (a: number, b: number) => fromCents(toCents(a) - toCents(b));
const add = (a: number, b: number) => fromCents(toCents(a) + toCents(b));

export function computeSalesPurchaseMonth(r: SalesPurchaseRaw): SalesPurchaseMonth {
  const netSales = sub(r.sales_goods, r.sales_return);
  const hpp = sub(r.hpp, r.hpp_returned);
  const grossProfit = sub(netSales, hpp);
  return {
    month: r.month,
    grossSales: add(r.sales_goods, r.discount),
    discount: r.discount,
    salesReturn: r.sales_return,
    netSales,
    hpp,
    grossProfit,
    marginPct: netSales > 0 ? (grossProfit / netSales) * 100 : null,
    netPurchases: sub(r.purchases, r.purchase_return),
  };
}

/** Jumlah beberapa bulan jadi satu kolom "total"; margin dihitung ulang dari total, bukan rata-rata margin. */
export function sumSalesPurchase(months: SalesPurchaseMonth[]): SalesPurchaseMonth {
  const total = (pick: (m: SalesPurchaseMonth) => number) =>
    fromCents(months.reduce((s, m) => s + toCents(pick(m)), 0));
  const netSales = total((m) => m.netSales);
  const grossProfit = total((m) => m.grossProfit);
  return {
    month: "",
    grossSales: total((m) => m.grossSales),
    discount: total((m) => m.discount),
    salesReturn: total((m) => m.salesReturn),
    netSales,
    hpp: total((m) => m.hpp),
    grossProfit,
    marginPct: netSales > 0 ? (grossProfit / netSales) * 100 : null,
    netPurchases: total((m) => m.netPurchases),
  };
}

/** Selisih persen vs periode pembanding; null kalau pembanding 0 (tidak bermakna). */
export function changePct(current: number, previous: number): number | null {
  return previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100;
}

export async function getSalesPurchaseMonthly(from: string, to: string): Promise<SalesPurchaseMonth[]> {
  const { data, error } = await supabase.rpc("report_sales_purchase_monthly", { p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return ((data ?? []) as SalesPurchaseRaw[]).map((r) =>
    computeSalesPurchaseMonth({
      month: r.month,
      sales_goods: Number(r.sales_goods),
      discount: Number(r.discount),
      sales_return: Number(r.sales_return),
      hpp: Number(r.hpp),
      hpp_returned: Number(r.hpp_returned),
      purchases: Number(r.purchases),
      purchase_return: Number(r.purchase_return),
    })
  );
}
