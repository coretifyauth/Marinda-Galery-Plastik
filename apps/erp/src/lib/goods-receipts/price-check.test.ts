import { describe, expect, it } from "vitest";
import { findPriceDeviations } from "./calc";

const line = (netUnitCost: number) => ({ itemId: "a", itemName: "A", netUnitCost });

describe("findPriceDeviations", () => {
  it("mengabaikan barang tanpa rata-rata stok", () => {
    expect(findPriceDeviations([line(10000)], new Map())).toEqual([]);
    expect(findPriceDeviations([line(10000)], new Map([["a", 0]]))).toEqual([]);
  });

  it("menandai harga yang lewat batas, ke atas maupun ke bawah", () => {
    const avg = new Map([["a", 1000]]);
    expect(findPriceDeviations([line(1300)], avg)).toEqual([]);
    expect(findPriceDeviations([line(700)], avg)).toEqual([]);
    expect(findPriceDeviations([line(1301)], avg)).toHaveLength(1);
    expect(findPriceDeviations([line(10000)], avg)).toHaveLength(1);
    expect(findPriceDeviations([line(100)], avg)).toHaveLength(1);
  });
});
