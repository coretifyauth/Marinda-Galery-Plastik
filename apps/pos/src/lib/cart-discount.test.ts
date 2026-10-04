import { describe, expect, it, vi } from "vitest";

// Modul promo mengimpor klien Supabase & Dexie (butuh env/browser) -- yang dites di sini cuma
// logika murni resolver, jadi dependensi itu di-stub.
vi.mock("./supabase/client", () => ({ supabase: {} }));
vi.mock("./local-db", () => ({ getKeyValue: vi.fn(), setKeyValue: vi.fn() }));

import { previewCartDiscounts } from "./cart-discount";
import type { CartLine } from "./pos-types";
import type { ItemDiscountRule } from "./promotion-item-discount-rules";
import type { BundlePromoRule } from "./promotion-bundle-rules";

function line(over: Partial<CartLine> & Pick<CartLine, "item_id" | "unit_label" | "conversion_factor" | "unit_price" | "qty_sold">): CartLine {
  return { name: over.item_id, available: 9999, ...over };
}

const noCategories = new Map<string, string | null>();

describe("previewCartDiscounts -- satuan non-dasar harus sama dengan hitungan server (satuan dasar)", () => {
  it("NOMINAL Rp100 per pcs: 2 bal (250 pcs) = Rp25.000, bukan Rp200", () => {
    const rules: ItemDiscountRule[] = [
      { id: "r1", item_id: "A", category_id: null, discount_type: "NOMINAL", discount_value: 100 },
    ];
    const cart = [line({ item_id: "A", unit_label: "bal", conversion_factor: 125, unit_price: 95000, qty_sold: 2 })];
    const [l] = previewCartDiscounts(cart, noCategories, rules, []);
    expect(l.combinedDiscount).toBe(25000);
    expect(l.discountRuleId).toBe("r1");
  });

  it("PERCENT tidak terpengaruh satuan: 10% dari Rp190.000 = Rp19.000", () => {
    const rules: ItemDiscountRule[] = [
      { id: "r1", item_id: "A", category_id: null, discount_type: "PERCENT", discount_value: 10 },
    ];
    const cart = [line({ item_id: "A", unit_label: "bal", conversion_factor: 125, unit_price: 95000, qty_sold: 2 })];
    expect(previewCartDiscounts(cart, noCategories, rules, [])[0].combinedDiscount).toBe(19000);
  });

  it("aturan kategori ikut: barang tanpa aturan sendiri jatuh ke aturan kategorinya", () => {
    const rules: ItemDiscountRule[] = [
      { id: "rc", item_id: null, category_id: "cat1", discount_type: "NOMINAL", discount_value: 2 },
    ];
    const cart = [line({ item_id: "A", unit_label: "ikat", conversion_factor: 5, unit_price: 3800, qty_sold: 3 })];
    const [l] = previewCartDiscounts(cart, new Map([["A", "cat1"]]), rules, []);
    expect(l.combinedDiscount).toBe(30); // 3 ikat = 15 pcs x Rp2
  });

  it("bundle: beli 2 Sabun gratis 1 Shampo, 1 lusin Sabun (12 pcs) + 1 lusin Shampo => 6 Shampo gratis", () => {
    const bundle: BundlePromoRule[] = [
      { id: "b1", trigger_item_id: "SABUN", buy_qty: 2, reward_item_id: "SHAMPO", free_qty: 1 },
    ];
    const cart = [
      line({ item_id: "SABUN", unit_label: "lusin", conversion_factor: 12, unit_price: 120000, qty_sold: 1 }),
      line({ item_id: "SHAMPO", unit_label: "lusin", conversion_factor: 12, unit_price: 180000, qty_sold: 1 }),
    ];
    const result = previewCartDiscounts(cart, noCategories, [], bundle);
    expect(result[0].combinedDiscount).toBe(0);
    // 6 pcs gratis x Rp15.000/pcs = Rp90.000
    expect(result[1].combinedDiscount).toBe(90000);
    expect(result[1].bundlePromoRuleId).toBe("b1");
  });

  it("bundle barang sama (beli 2 gratis 1), 1 baris dalam ikat: set = 3 pcs dasar", () => {
    const bundle: BundlePromoRule[] = [
      { id: "b1", trigger_item_id: "K", buy_qty: 2, reward_item_id: "K", free_qty: 1 },
    ];
    // 2 ikat = 10 pcs -> floor(10/3) = 3 pcs gratis x Rp900/pcs (4.500 / 5) = Rp2.700
    const cart = [line({ item_id: "K", unit_label: "ikat", conversion_factor: 5, unit_price: 4500, qty_sold: 2 })];
    expect(previewCartDiscounts(cart, noCategories, [], bundle)[0].combinedDiscount).toBe(2700);
  });

  it("bundle: qty pemicu dijumlah lintas satuan (1 pcs + 1 ikat Sabun = 6 pcs) => 3 Shampo gratis", () => {
    const bundle: BundlePromoRule[] = [
      { id: "b1", trigger_item_id: "SABUN", buy_qty: 2, reward_item_id: "SHAMPO", free_qty: 1 },
    ];
    const cart = [
      line({ item_id: "SABUN", unit_label: "pcs", conversion_factor: 1, unit_price: 10000, qty_sold: 1 }),
      line({ item_id: "SABUN", unit_label: "ikat", conversion_factor: 5, unit_price: 45000, qty_sold: 1 }),
      line({ item_id: "SHAMPO", unit_label: "pcs", conversion_factor: 1, unit_price: 15000, qty_sold: 5 }),
    ];
    const result = previewCartDiscounts(cart, noCategories, [], bundle);
    expect(result[2].combinedDiscount).toBe(45000); // floor(6/2) = 3 gratis x Rp15.000
  });

  it("diskon gabungan tidak boleh melebihi nilai kotor baris", () => {
    const rules: ItemDiscountRule[] = [
      { id: "r1", item_id: "A", category_id: null, discount_type: "PERCENT", discount_value: 100 },
    ];
    const bundle: BundlePromoRule[] = [
      { id: "b1", trigger_item_id: "A", buy_qty: 1, reward_item_id: "A", free_qty: 1 },
    ];
    const cart = [line({ item_id: "A", unit_label: "pcs", conversion_factor: 1, unit_price: 1000, qty_sold: 4 })];
    expect(previewCartDiscounts(cart, noCategories, rules, bundle)[0].combinedDiscount).toBe(4000);
  });

  it("baris dasar (faktor 1) hasilnya sama seperti sebelum perbaikan", () => {
    const rules: ItemDiscountRule[] = [
      { id: "r1", item_id: "A", category_id: null, discount_type: "NOMINAL", discount_value: 100 },
    ];
    const cart = [line({ item_id: "A", unit_label: "pcs", conversion_factor: 1, unit_price: 800, qty_sold: 10 })];
    expect(previewCartDiscounts(cart, noCategories, rules, [])[0].combinedDiscount).toBe(1000);
  });
});

// Barang A: 1 dos = 1.250 pcs, Rp900.000/dos (Rp720/pcs). Aturan bertingkat: >=10 dos 5%, >=50 dos 8%.
const DOS = 1250;
const tierRules: ItemDiscountRule[] = [
  { id: "t10", item_id: "A", category_id: null, discount_type: "PERCENT", discount_value: 5, min_qty_base: 10 * DOS },
  { id: "t50", item_id: "A", category_id: null, discount_type: "PERCENT", discount_value: 8, min_qty_base: 50 * DOS },
];
const dosLine = (qty: number) =>
  line({ item_id: "A", unit_label: "dos", conversion_factor: DOS, unit_price: 900000, qty_sold: qty });

describe("previewCartDiscounts -- diskon bertingkat (syarat minimal qty)", () => {
  it("9 dos: belum memenuhi syarat, tanpa diskon", () => {
    expect(previewCartDiscounts([dosLine(9)], noCategories, tierRules, [])[0].combinedDiscount).toBe(0);
  });

  it("12 dos: tingkat >=10 dos, 5% dari seluruh nilai = Rp540.000", () => {
    const [l] = previewCartDiscounts([dosLine(12)], noCategories, tierRules, []);
    expect(l.combinedDiscount).toBe(540000);
    expect(l.discountRuleId).toBe("t10");
  });

  it("55 dos: hanya tingkat tertinggi (8% = Rp3.960.000), tidak ditumpuk dengan 5%", () => {
    const [l] = previewCartDiscounts([dosLine(55)], noCategories, tierRules, []);
    expect(l.combinedDiscount).toBe(3960000);
    expect(l.discountRuleId).toBe("t50");
  });

  it("syarat dijumlah lintas satuan & baris: 8 dos + 2.500 pcs (= 10 dos) memenuhi, diskon ke KEDUA baris", () => {
    const cart = [
      dosLine(8),
      line({ item_id: "A", unit_label: "pcs", conversion_factor: 1, unit_price: 720, qty_sold: 2500 }),
    ];
    const result = previewCartDiscounts(cart, noCategories, tierRules, []);
    expect(result[0].combinedDiscount).toBe(360000); // 5% x 7.200.000
    expect(result[1].combinedDiscount).toBe(90000); // 5% x 1.800.000
  });

  it("8 dos + 2.499 pcs (kurang 1 pcs dari 10 dos): tidak memenuhi", () => {
    const cart = [
      dosLine(8),
      line({ item_id: "A", unit_label: "pcs", conversion_factor: 1, unit_price: 720, qty_sold: 2499 }),
    ];
    const result = previewCartDiscounts(cart, noCategories, tierRules, []);
    expect(result[0].combinedDiscount).toBe(0);
    expect(result[1].combinedDiscount).toBe(0);
  });

  it("aturan barang belum terpenuhi -> jatuh ke aturan kategori (tanpa syarat)", () => {
    const rules: ItemDiscountRule[] = [
      ...tierRules,
      { id: "kat", item_id: null, category_id: "cat1", discount_type: "PERCENT", discount_value: 2 },
    ];
    const [l] = previewCartDiscounts([dosLine(5)], new Map([["A", "cat1"]]), rules, []);
    expect(l.discountRuleId).toBe("kat");
    expect(l.combinedDiscount).toBe(90000); // 2% x 4.500.000
  });

  it("aturan barang terpenuhi menang atas kategori", () => {
    const rules: ItemDiscountRule[] = [
      ...tierRules,
      { id: "kat", item_id: null, category_id: "cat1", discount_type: "PERCENT", discount_value: 2 },
    ];
    expect(previewCartDiscounts([dosLine(10)], new Map([["A", "cat1"]]), rules, [])[0].discountRuleId).toBe("t10");
  });

  it("aturan lama tanpa min_qty_base (cache offline lama) tetap berlaku dari unit pertama", () => {
    const rules: ItemDiscountRule[] = [
      { id: "lama", item_id: "A", category_id: null, discount_type: "PERCENT", discount_value: 10 },
    ];
    expect(previewCartDiscounts([dosLine(1)], noCategories, rules, [])[0].combinedDiscount).toBe(90000);
  });
});

describe("previewCartDiscounts -- bundle: jatah hadiah dibagi antar baris & jenis hadiah", () => {
  const sabunShampo: BundlePromoRule = {
    id: "b1",
    trigger_item_id: "SABUN",
    buy_qty: 2,
    reward_item_id: "SHAMPO",
    free_qty: 1,
  };
  const sabun = (qty: number) =>
    line({ item_id: "SABUN", unit_label: "pcs", conversion_factor: 1, unit_price: 10000, qty_sold: qty });

  it("hadiah di 2 baris (2 pcs + 1 ikat=5 pcs), hak 3: total gratis 3, bukan 5 (hitung ganda diperbaiki)", () => {
    const cart = [
      sabun(6), // hak = floor(6/2) x 1 = 3 Shampo
      line({ item_id: "SHAMPO", unit_label: "pcs", conversion_factor: 1, unit_price: 15000, qty_sold: 2 }),
      line({ item_id: "SHAMPO", unit_label: "ikat", conversion_factor: 5, unit_price: 75000, qty_sold: 1 }),
    ];
    const result = previewCartDiscounts(cart, noCategories, [], [sabunShampo]);
    expect(result[1].combinedDiscount).toBe(30000); // 2 pcs x Rp15.000 (ambil 2 dari jatah 3)
    expect(result[2].combinedDiscount).toBe(15000); // sisa jatah 1 pcs x Rp15.000, BUKAN 3
    expect(result[1].combinedDiscount + result[2].combinedDiscount).toBe(45000); // 3 x 15.000
  });

  it("hadiah PERCENT 50%: hanya qty yang berhak yang dipotong", () => {
    const rule: BundlePromoRule = { ...sabunShampo, reward_type: "PERCENT", reward_value: 50 };
    const cart = [
      sabun(2), // hak 1 Shampo
      line({ item_id: "SHAMPO", unit_label: "pcs", conversion_factor: 1, unit_price: 15000, qty_sold: 3 }),
    ];
    // 1 pcs x 50% x 15.000 = 7.500, 2 pcs sisanya harga penuh
    expect(previewCartDiscounts(cart, noCategories, [], [rule])[1].combinedDiscount).toBe(7500);
  });

  it("hadiah NOMINAL Rp4.000 per pcs: dibatasi harga satuan (tidak melebihi harga)", () => {
    const rule: BundlePromoRule = { ...sabunShampo, reward_type: "NOMINAL", reward_value: 4000 };
    const cart = [
      sabun(4), // hak 2
      line({ item_id: "SHAMPO", unit_label: "pcs", conversion_factor: 1, unit_price: 3000, qty_sold: 5 }),
    ];
    expect(previewCartDiscounts(cart, noCategories, [], [rule])[1].combinedDiscount).toBe(6000); // 2 x min(4000, 3000)
  });

  it("beli 10 dos gratis 1 dos (barang sama): 22 dos -> 2 dos gratis, bayar 20 dos", () => {
    // N=10 dos=12.500 pcs, X=1 dos=1.250 pcs; set = 13.750 pcs
    const rule: BundlePromoRule = {
      id: "b10",
      trigger_item_id: "A",
      buy_qty: 10 * DOS,
      reward_item_id: "A",
      free_qty: 1 * DOS,
    };
    const [l] = previewCartDiscounts([dosLine(22)], noCategories, [], [rule]);
    expect(l.combinedDiscount).toBe(1800000); // 2 dos x Rp900.000
  });

  it("aturan lama tanpa reward_type (cache offline lama) tetap gratis penuh", () => {
    const cart = [
      sabun(2),
      line({ item_id: "SHAMPO", unit_label: "pcs", conversion_factor: 1, unit_price: 15000, qty_sold: 1 }),
    ];
    expect(previewCartDiscounts(cart, noCategories, [], [sabunShampo])[1].combinedDiscount).toBe(15000);
  });
});

