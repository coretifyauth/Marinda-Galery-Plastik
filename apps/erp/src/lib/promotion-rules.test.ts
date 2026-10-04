import { describe, expect, it, vi } from "vitest";

// Resolver cuma logika murni; klien Supabase (butuh env) di-stub.
vi.mock("@/lib/supabase/client", () => ({ supabase: {} }));

import {
  resolveItemDiscount,
  resolveLineItemDiscounts,
  itemDiscountRuleSchema,
  type ItemDiscountRule,
} from "@/lib/promotion-item-discount-rules/schema";
import {
  resolveBundlePromoDiscounts,
  bundlePromoRuleSchema,
  type BundlePromoRule,
} from "@/lib/promotion-bundle-rules/schema";

const DOS = 1250; // 1 dos = 1.250 pcs, Rp900.000/dos
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function rule(over: Partial<ItemDiscountRule> & Pick<ItemDiscountRule, "id">): ItemDiscountRule {
  return {
    name: over.id,
    item_id: "A",
    category_id: null,
    discount_type: "PERCENT",
    discount_value: 5,
    archived_at: null,
    ...over,
  };
}

const tiers = [
  rule({ id: "t10", discount_value: 5, min_qty_base: 10 * DOS }),
  rule({ id: "t50", discount_value: 8, min_qty_base: 50 * DOS }),
];

const line = (baseQty: number, price = 900000 / DOS) => ({
  item_id: "A",
  category_id: null as string | null,
  baseQty,
  amount: baseQty * price,
});

describe("resolveItemDiscount -- bertingkat", () => {
  it("di bawah syarat: tanpa diskon", () => {
    expect(resolveItemDiscount("A", null, 9 * DOS, 9 * 900000, tiers)).toBeNull();
  });

  it("12 dos: 5% dari seluruh nilai", () => {
    const r = resolveItemDiscount("A", null, 12 * DOS, 12 * 900000, tiers);
    expect(r).toEqual({ discount_rule_id: "t10", discount_amount: 540000 });
  });

  it("55 dos: hanya tingkat tertinggi (8%), tidak ditumpuk", () => {
    const r = resolveItemDiscount("A", null, 55 * DOS, 55 * 900000, tiers);
    expect(r).toEqual({ discount_rule_id: "t50", discount_amount: 3960000 });
  });

  it("totalQty (lintas baris) menentukan syarat, diskon tetap dihitung ke qty baris ini", () => {
    // baris ini 8 dos, tapi total barang di transaksi 12 dos -> tingkat >=10 dos terpenuhi
    const r = resolveItemDiscount("A", null, 8 * DOS, 8 * 900000, tiers, 12 * DOS);
    expect(r).toEqual({ discount_rule_id: "t10", discount_amount: 360000 });
  });

  it("aturan lama tanpa min_qty_base tetap berlaku dari unit pertama", () => {
    const lama = [rule({ id: "lama", discount_value: 10 })];
    expect(resolveItemDiscount("A", null, 1, 1000, lama)?.discount_amount).toBe(100);
  });

  it("aturan barang belum terpenuhi -> jatuh ke aturan kategori", () => {
    const rules = [...tiers, rule({ id: "kat", item_id: null, category_id: "c1", discount_value: 2 })];
    expect(resolveItemDiscount("A", "c1", 5 * DOS, 5 * 900000, rules)?.discount_rule_id).toBe("kat");
    expect(resolveItemDiscount("A", "c1", 10 * DOS, 10 * 900000, rules)?.discount_rule_id).toBe("t10");
  });
});

describe("resolveLineItemDiscounts -- cart-wide", () => {
  it("8 dos + 2.500 pcs di 2 baris (= 10 dos) memenuhi syarat, diskon ke kedua baris", () => {
    const r = resolveLineItemDiscounts([line(8 * DOS), line(2500)], tiers);
    expect(r[0]?.discount_amount).toBe(360000);
    expect(r[1]?.discount_amount).toBe(90000);
  });

  it("kurang 1 pcs dari 10 dos: tidak ada diskon", () => {
    const r = resolveLineItemDiscounts([line(8 * DOS), line(2499)], tiers);
    expect(r).toEqual([null, null]);
  });

  it("baris kosong (qty 0) dilewati", () => {
    expect(resolveLineItemDiscounts([line(0)], tiers)).toEqual([null]);
  });

  it("SO bertahap: pesan 12 dos, kirim 6 dos -> syarat dicek ke total DIPESAN, diskon ke qty dikirim", () => {
    const ordered = new Map([["A", 12 * DOS]]);
    const kirim = resolveLineItemDiscounts([line(6 * DOS)], tiers, ordered);
    expect(kirim[0]).toEqual({ discount_rule_id: "t10", discount_amount: 270000 }); // 5% x 5.400.000
    // tanpa override (per pengiriman saja) 6 dos tidak memenuhi -> inilah yang dihindari
    expect(resolveLineItemDiscounts([line(6 * DOS)], tiers)[0]).toBeNull();
  });
});

describe("resolveBundlePromoDiscounts", () => {
  const sabunShampo: BundlePromoRule = {
    id: "b1",
    name: "b1",
    trigger_item_id: "SABUN",
    buy_qty: 2,
    reward_item_id: "SHAMPO",
    free_qty: 1,
    archived_at: null,
  };
  const L = (item_id: string, qty: number, unit_price: number) => ({ item_id, qty, unit_price });

  it("hadiah di 2 baris: jatah 3 dibagi berurutan (2 + 1), total gratis 3 bukan 5", () => {
    const r = resolveBundlePromoDiscounts([L("SABUN", 6, 10000), L("SHAMPO", 2, 15000), L("SHAMPO", 5, 15000)], [sabunShampo]);
    expect(r.get(1)?.discount_amount).toBe(30000);
    expect(r.get(2)?.discount_amount).toBe(15000);
  });

  it("hadiah PERCENT / NOMINAL hanya untuk qty yang berhak", () => {
    const pct = { ...sabunShampo, reward_type: "PERCENT" as const, reward_value: 50 };
    expect(resolveBundlePromoDiscounts([L("SABUN", 2, 10000), L("SHAMPO", 3, 15000)], [pct]).get(1)?.discount_amount).toBe(7500);
    const nom = { ...sabunShampo, reward_type: "NOMINAL" as const, reward_value: 4000 };
    expect(resolveBundlePromoDiscounts([L("SABUN", 4, 10000), L("SHAMPO", 5, 3000)], [nom]).get(1)?.discount_amount).toBe(6000);
  });

  it("beli 10 dos gratis 1 dos (barang sama, dalam satuan dasar): 22 dos -> 2 dos gratis", () => {
    const r: BundlePromoRule = {
      id: "b10",
      name: "b10",
      trigger_item_id: "A",
      buy_qty: 10 * DOS,
      reward_item_id: "A",
      free_qty: DOS,
      archived_at: null,
    };
    const result = resolveBundlePromoDiscounts([L("A", 22 * DOS, 900000 / DOS)], [r]);
    expect(result.get(0)?.discount_amount).toBe(1800000);
  });

  it("baris berharga 0 tidak menghabiskan jatah baris berikutnya", () => {
    const result = resolveBundlePromoDiscounts(
      [L("SABUN", 2, 10000), L("SHAMPO", 1, 0), L("SHAMPO", 1, 15000)],
      [sabunShampo]
    );
    expect(result.has(1)).toBe(false);
    expect(result.get(2)?.discount_amount).toBe(15000);
  });

  it("aturan lama tanpa reward_type tetap gratis penuh", () => {
    expect(resolveBundlePromoDiscounts([L("SABUN", 2, 10000), L("SHAMPO", 1, 15000)], [sabunShampo]).get(1)?.discount_amount).toBe(15000);
  });
});

describe("validasi form (zod)", () => {
  const base = { name: "x", item_id: UUID_A, category_id: null, discount_type: "PERCENT", discount_value: 5 };

  it("syarat minimal harus berpasangan dengan satuan", () => {
    expect(itemDiscountRuleSchema.safeParse({ ...base, min_qty: 10, min_qty_unit_id: UUID_B }).success).toBe(true);
    expect(itemDiscountRuleSchema.safeParse({ ...base, min_qty: 10, min_qty_unit_id: null }).success).toBe(false);
    expect(itemDiscountRuleSchema.safeParse({ ...base }).success).toBe(true);
  });

  it("syarat minimal ditolak untuk aturan kategori", () => {
    const kategori = { ...base, item_id: null, category_id: UUID_A, min_qty: 10, min_qty_unit_id: UUID_B };
    expect(itemDiscountRuleSchema.safeParse(kategori).success).toBe(false);
  });

  it("hadiah bundle: FREE tanpa nilai, PERCENT/NOMINAL wajib nilai, persen maks 100", () => {
    const b = { name: "b", trigger_item_id: UUID_A, buy_qty: 2, reward_item_id: UUID_B, free_qty: 1 };
    expect(bundlePromoRuleSchema.safeParse(b).success).toBe(true);
    expect(bundlePromoRuleSchema.safeParse({ ...b, reward_type: "FREE", reward_value: 10 }).success).toBe(false);
    expect(bundlePromoRuleSchema.safeParse({ ...b, reward_type: "PERCENT" }).success).toBe(false);
    expect(bundlePromoRuleSchema.safeParse({ ...b, reward_type: "PERCENT", reward_value: 101 }).success).toBe(false);
    expect(bundlePromoRuleSchema.safeParse({ ...b, reward_type: "PERCENT", reward_value: 50 }).success).toBe(true);
    expect(bundlePromoRuleSchema.safeParse({ ...b, reward_type: "NOMINAL", reward_value: 4000 }).success).toBe(true);
  });

  it("qty beli/hadiah harus berpasangan dengan satuannya", () => {
    const b = { name: "b", trigger_item_id: UUID_A, buy_qty: 2, reward_item_id: UUID_B, free_qty: 1 };
    expect(bundlePromoRuleSchema.safeParse({ ...b, buy_unit_id: UUID_A, buy_unit_qty: 10 }).success).toBe(true);
    expect(bundlePromoRuleSchema.safeParse({ ...b, buy_unit_id: UUID_A }).success).toBe(false);
    expect(bundlePromoRuleSchema.safeParse({ ...b, reward_unit_qty: 1 }).success).toBe(false);
  });
});
