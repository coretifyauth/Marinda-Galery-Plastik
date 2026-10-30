import { describe, expect, it } from "vitest";
import { formatStockPerUnit } from "./stock-display";

const units = [
  { unit_label: "box", conversion_factor: 100 },
  { unit_label: "pcs", conversion_factor: 1 },
  { unit_label: "pack", conversion_factor: 10 },
];

describe("formatStockPerUnit", () => {
  it("menyatakan qty & avg cost di tiap satuan, terkecil ke terbesar", () => {
    expect(formatStockPerUnit(166, 500, "pcs", units)).toEqual([
      { unitLabel: "pcs", qty: "166", avgCost: "500" },
      { unitLabel: "pack", qty: "16,6", avgCost: "5.000" },
      { unitLabel: "box", qty: "1,66", avgCost: "50.000" },
    ]);
  });

  it("item tanpa baris item_units tetap tampil di satuan dasar", () => {
    expect(formatStockPerUnit(2.5, 1000, "kg", [])).toEqual([{ unitLabel: "kg", qty: "2,5", avgCost: "1.000" }]);
  });

  it("membulatkan qty ke bawah supaya stok belum genap gak terbaca genap", () => {
    expect(formatStockPerUnit(9999, 1, "pcs", [{ unit_label: "sak", conversion_factor: 10000 }])[1].qty).toBe("0,999");
  });

  it("gak kena artefak float saat qty pas di presisi 3 desimal", () => {
    expect(formatStockPerUnit(1001, 1, "pcs", [{ unit_label: "pack", conversion_factor: 1000 }])[1].qty).toBe("1,001");
  });

  it("stok terlalu kecil buat 3 desimal gak ditampilkan sebagai nol", () => {
    const [, sak] = formatStockPerUnit(1, 1, "pcs", [{ unit_label: "sak", conversion_factor: 19200 }]);
    expect(sak.qty).toBe("< 0,001");
  });

  it("stok nol tetap nol di semua satuan", () => {
    expect(formatStockPerUnit(0, 500, "pcs", units).map((u) => u.qty)).toEqual(["0", "0", "0"]);
  });

  it("avg cost pecahan gak bocor artefak float", () => {
    expect(formatStockPerUnit(1, 33.33, "pcs", [{ unit_label: "lusin", conversion_factor: 12 }])[1].avgCost).toBe("399,96");
  });
});
