import { describe, expect, it } from "vitest";
import { grossMargin, splitInvoiceLines } from "./margin";

describe("splitInvoiceLines", () => {
  it("memisahkan penjualan barang, biaya tambahan, dan PPN", () => {
    const r = splitInvoiceLines(
      [
        { account_id: "rev", amount: 900_000, is_tax: false },
        { account_id: "ongkir", amount: 20_000, is_tax: false },
        { account_id: "ppn", amount: 99_000, is_tax: true },
      ],
      new Set(["ongkir"])
    );
    expect(r).toEqual({ goodsRevenue: 900_000, extraCharges: 20_000, ppn: 99_000 });
  });

  it("sen tidak melenceng", () => {
    const r = splitInvoiceLines(
      [
        { account_id: "rev", amount: 0.1, is_tax: false },
        { account_id: "rev", amount: 0.2, is_tax: false },
      ],
      new Set()
    );
    expect(r.goodsRevenue).toBe(0.3);
  });
});

describe("grossMargin", () => {
  it("laba dan margin dari penjualan barang", () => {
    expect(grossMargin(900_000, 600_000)).toEqual({ profit: 300_000, marginPct: (300_000 / 900_000) * 100 });
  });
  it("margin null tanpa penjualan; laba boleh negatif", () => {
    expect(grossMargin(0, 100).marginPct).toBeNull();
    expect(grossMargin(100, 150)).toEqual({ profit: -50, marginPct: -50 });
  });
});
