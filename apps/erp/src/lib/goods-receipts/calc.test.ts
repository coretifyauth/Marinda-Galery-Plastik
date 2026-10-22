import { describe, expect, it } from "vitest";
import { receiptTotals } from "./calc";

describe("receiptTotals", () => {
  it("menjumlah subtotal, diskon item, dan diskon tambahan", () => {
    const t = receiptTotals(
      [
        { qty: 10, unitCost: 10000, itemDiscount: 20000 },
        { qty: 5, unitCost: 4000, itemDiscount: 0 },
      ],
      5000
    );
    expect(t.subtotal).toBe(120000);
    expect(t.itemDiscountTotal).toBe(20000);
    expect(t.totalDiscount).toBe(25000);
    expect(t.total).toBe(95000);
    expect(t.problems).toEqual([]);
  });

  it("menghitung baris berharga 0 dan tetap mengizinkannya", () => {
    const t = receiptTotals(
      [
        { qty: 50, unitCost: 0, itemDiscount: 0 },
        { qty: 1, unitCost: 100, itemDiscount: 0 },
      ],
      0
    );
    expect(t.zeroLineCount).toBe(1);
    expect(t.total).toBe(100);
    expect(t.problems).toEqual([]);
  });

  it("menandai diskon item yang melebihi nilai barisnya", () => {
    const t = receiptTotals([{ qty: 2, unitCost: 1000, itemDiscount: 2500 }], 0);
    expect(t.problems.some((p) => p.includes("baris ke-1"))).toBe(true);
  });

  it("menandai diskon tambahan yang melebihi nilai setelah diskon item", () => {
    const t = receiptTotals([{ qty: 2, unitCost: 1000, itemDiscount: 500 }], 1600);
    expect(t.problems.some((p) => p.includes("Diskon tambahan"))).toBe(true);
  });

  it("menolak diskon negatif", () => {
    const t = receiptTotals([{ qty: 1, unitCost: 1000, itemDiscount: -1 }], -5);
    expect(t.problems.length).toBe(2);
  });
});
