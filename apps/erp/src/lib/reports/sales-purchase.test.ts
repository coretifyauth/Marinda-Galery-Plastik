import { describe, expect, it, vi } from "vitest";

// sales-purchase.ts mengimpor klien Supabase (butuh env) -- yang dites cuma fungsi compute murni.
vi.mock("@/lib/supabase/client", () => ({ supabase: {} }));

import { changePct, computeSalesPurchaseMonth, sumSalesPurchase } from "./sales-purchase";

// Contoh angka di docs/domain/financial-reports.md "Dashboard Penjualan & Pembelian":
// jual (setelah diskon) 9jt, retur 0,5jt, HPP 5,5jt, beli 12jt.
const raw = {
  month: "2026-10-01",
  sales_goods: 9_000_000,
  discount: 1_000_000,
  sales_return: 500_000,
  hpp: 5_500_000,
  hpp_returned: 0,
  purchases: 12_000_000,
  purchase_return: 0,
};

describe("computeSalesPurchaseMonth", () => {
  it("penjualan bersih, laba kotor, margin; pembelian TIDAK mengurangi laba", () => {
    const m = computeSalesPurchaseMonth(raw);
    expect(m.grossSales).toBe(10_000_000);
    expect(m.netSales).toBe(8_500_000);
    expect(m.grossProfit).toBe(3_000_000);
    expect(m.marginPct).toBeCloseTo(35.29, 1);
    expect(m.netPurchases).toBe(12_000_000);
  });

  it("HPP retur dikembalikan, retur ke supplier mengurangi pembelian", () => {
    const m = computeSalesPurchaseMonth({ ...raw, hpp_returned: 300_000, purchase_return: 2_000_000 });
    expect(m.hpp).toBe(5_200_000);
    expect(m.grossProfit).toBe(3_300_000);
    expect(m.netPurchases).toBe(10_000_000);
  });

  it("tanpa penjualan: margin null, bukan NaN/Infinity", () => {
    const m = computeSalesPurchaseMonth({ ...raw, sales_goods: 0, discount: 0, sales_return: 0, hpp: 0 });
    expect(m.marginPct).toBeNull();
  });

  it("sen tidak melenceng (0,1 + 0,2)", () => {
    const m = computeSalesPurchaseMonth({ ...raw, sales_goods: 0.3, sales_return: 0.1, hpp: 0, discount: 0.1 });
    expect(m.netSales).toBe(0.2);
    expect(m.grossSales).toBe(0.4);
  });
});

describe("sumSalesPurchase", () => {
  it("margin total dihitung dari total, bukan rata-rata margin bulanan", () => {
    const a = computeSalesPurchaseMonth({ ...raw, sales_goods: 1_000_000, discount: 0, sales_return: 0, hpp: 500_000 });
    const b = computeSalesPurchaseMonth({ ...raw, sales_goods: 9_000_000, discount: 0, sales_return: 0, hpp: 8_100_000 });
    const t = sumSalesPurchase([a, b]);
    expect(t.netSales).toBe(10_000_000);
    expect(t.grossProfit).toBe(1_400_000);
    expect(t.marginPct).toBeCloseTo(14, 5); // rata-rata margin bulanan akan 30 -- salah
  });
});

describe("changePct", () => {
  it("null kalau pembanding 0", () => {
    expect(changePct(100, 0)).toBeNull();
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(50, 100)).toBe(-50);
  });
});
