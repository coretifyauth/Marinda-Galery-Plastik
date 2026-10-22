import { describe, expect, it } from "vitest";
import { normalizeReceiptLine, receiptTotals } from "./calc";

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

  it("menandai harga 0 -- barang masuk wajib berharga", () => {
    const t = receiptTotals(
      [
        { qty: 50, unitCost: 0, itemDiscount: 0 },
        { qty: 1, unitCost: 100, itemDiscount: 0 },
      ],
      0
    );
    expect(t.total).toBe(100);
    expect(t.problems.some((p) => p.includes("baris ke-1") && p.includes("lebih dari 0"))).toBe(true);
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

describe("normalizeReceiptLine", () => {
  it("harga bulat tidak berubah dan tidak menambah diskon", () => {
    expect(normalizeReceiptLine(10, 10000, 0)).toEqual({ qty: 10, unitCost: 10000, discount: 0 });
    expect(normalizeReceiptLine(3, 833.33, 0)).toEqual({ qty: 3, unitCost: 833.33, discount: 0 });
  });

  it("harga hasil konversi satuan: dibulatkan ke atas, selisih jadi diskon, nilai bersih = nilai nota", () => {
    // 1 dus isi 12 @ Rp10.000 -> Rp833,3333/pcs, 12 pcs
    const n = normalizeReceiptLine(12, 10000 / 12, 0);
    expect(n.unitCost).toBe(833.34);
    expect(n.discount).toBe(0.08);
    expect(Math.round((n.qty * n.unitCost - n.discount) * 100) / 100).toBe(10000);
  });

  it("menambahkan selisih pembulatan di atas diskon item yang sudah diisi", () => {
    const n = normalizeReceiptLine(12, 10000 / 12, 500);
    expect(n.discount).toBe(500.08);
  });

  it("tidak menghasilkan diskon negatif dan tahan noise floating point", () => {
    expect(normalizeReceiptLine(7, 0.1 + 0.2, 0).unitCost).toBe(0.3);
    expect(normalizeReceiptLine(1, 833.3, 0)).toEqual({ qty: 1, unitCost: 833.3, discount: 0 });
  });

  it("membulatkan qty ke 3 desimal", () => {
    expect(normalizeReceiptLine(2.5000000001, 1000, 0).qty).toBe(2.5);
  });
});
