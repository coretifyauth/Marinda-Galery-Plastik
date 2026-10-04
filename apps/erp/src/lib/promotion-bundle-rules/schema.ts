import { z } from "zod";
import { supabase } from "@/lib/supabase/client";

/** Ref: docs/domain/accounts-receivable.md submodule "Beli N Gratis X (Bundle Promo)",
 * docs/architecture/promotion-bundle-rules-schema.md. Mirror SQL: resolve_bundle_promo_discounts
 * (supabase/migrations/0047_rename_promotion_rules_tables.sql), dipakai create_pos_sale
 * server-side -- versi TypeScript ini dipakai sisi admin (client-computed, RPC trust) DAN
 * preview tampilan POS (non-otoritatif, lihat apps/pos). */
export const bundlePromoRuleSchema = z.object({
  name: z.string().min(1, "Nama promo wajib diisi"),
  trigger_item_id: z.string().uuid("Pilih barang pemicu"),
  buy_qty: z.coerce.number().positive("Qty beli harus lebih dari 0"),
  reward_item_id: z.string().uuid("Pilih barang hadiah"),
  free_qty: z.coerce.number().positive("Qty gratis harus lebih dari 0"),
  // N/X dalam satuan tertentu (opsional): kalau satuan diisi, buy_qty/free_qty yang tersimpan
  // dihitung ulang DB (trigger) dari qty-ketikan x faktor satuan. Kosong = satuan dasar.
  buy_unit_id: z.string().uuid().nullable().optional(),
  buy_unit_qty: z.coerce.number().positive().nullable().optional(),
  reward_unit_id: z.string().uuid().nullable().optional(),
  reward_unit_qty: z.coerce.number().positive().nullable().optional(),
  reward_type: z.enum(["FREE", "PERCENT", "NOMINAL"]).default("FREE"),
  reward_value: z.coerce.number().positive("Nilai diskon hadiah harus lebih dari 0").nullable().optional(),
})
  .refine((v) => (v.buy_unit_id == null) === (v.buy_unit_qty == null), {
    message: "Qty beli dan satuannya harus diisi bersamaan",
    path: ["buy_unit_qty"],
  })
  .refine((v) => (v.reward_unit_id == null) === (v.reward_unit_qty == null), {
    message: "Qty hadiah dan satuannya harus diisi bersamaan",
    path: ["reward_unit_qty"],
  })
  .refine((v) => (v.reward_type === "FREE" ? v.reward_value == null : v.reward_value != null), {
    message: "Nilai diskon hadiah wajib diisi untuk hadiah diskon, dan harus kosong untuk hadiah gratis",
    path: ["reward_value"],
  })
  .refine((v) => v.reward_type !== "PERCENT" || (v.reward_value ?? 0) <= 100, {
    message: "Diskon persen maksimal 100",
    path: ["reward_value"],
  });

export type BundlePromoRule = {
  id: string;
  name: string;
  trigger_item_id: string;
  buy_qty: number;
  reward_item_id: string;
  free_qty: number;
  archived_at: string | null;
  /** FREE (harga jadi Rp0) / PERCENT / NOMINAL (Rp per satuan dasar barang hadiah). Opsional di tipe: cache lama belum punya -> dianggap FREE. */
  reward_type?: "FREE" | "PERCENT" | "NOMINAL";
  reward_value?: number | null;
  buy_unit_id?: string | null;
  buy_unit_qty?: number | null;
  reward_unit_id?: string | null;
  reward_unit_qty?: number | null;
};

export async function fetchActiveBundlePromoRules(): Promise<BundlePromoRule[]> {
  const { data } = await supabase
    .from("promotion_bundle_rules")
    .select(
      "id, name, trigger_item_id, buy_qty, reward_item_id, free_qty, archived_at, reward_type, reward_value, buy_unit_id, buy_unit_qty, reward_unit_id, reward_unit_qty"
    )
    .is("archived_at", null);
  return (data ?? []) as BundlePromoRule[];
}

export type BundlePromoLineInput = { item_id: string; qty: number; unit_price: number };
export type ResolvedBundlePromo = { bundle_promo_rule_id: string; discount_amount: number };

/** Diskon per 1 unit satuan dasar barang hadiah, menurut jenis hadiah aturan. */
export function rewardDiscountPerUnit(rule: BundlePromoRule, unitPrice: number): number {
  switch (rule.reward_type ?? "FREE") {
    case "PERCENT":
      return (unitPrice * (rule.reward_value ?? 0)) / 100;
    case "NOMINAL":
      return Math.min(rule.reward_value ?? 0, unitPrice);
    default:
      return unitPrice;
  }
}

/**
 * Resolusi cart-wide (semua qty & harga dalam SATUAN DASAR): (1) jumlahkan qty per item_id lintas
 * SEMUA baris (basis qty pemicu), (2) tiap aturan punya POOL jatah hadiah = jumlah set penuh x
 * qty hadiah (trigger = reward: 1 set = buy+free unit fisik yang sama), (3) tiap baris barang
 * hadiah mengambil dari pool aturan-aturan yang menaunginya secara berurutan (urut id), dibatasi
 * qty baris itu dan SISA pool -- barang hadiah di >1 baris (mis. pcs + ikat) gak bisa lagi
 * masing-masing ngeklaim jatah penuh. Diskon per unit sesuai jenis hadiah (FREE/PERCENT/NOMINAL).
 * Baris berharga 0 dilewati (gak menghabiskan jatah). Return map index-baris -> hasil (index tanpa
 * diskon gak muncul). Mirror persis resolve_bundle_promo_discounts SQL (0050);
 * `bundle_promo_rule_id` = aturan pertama yang menyumbang diskon baris itu.
 */
export function resolveBundlePromoDiscounts(
  lines: BundlePromoLineInput[],
  rules: BundlePromoRule[]
): Map<number, ResolvedBundlePromo> {
  const qtyByItem = new Map<string, number>();
  for (const line of lines) {
    qtyByItem.set(line.item_id, (qtyByItem.get(line.item_id) ?? 0) + line.qty);
  }

  const pool = new Map<string, number>();
  const result = new Map<number, ResolvedBundlePromo>();
  lines.forEach((line, index) => {
    if (line.unit_price <= 0) return;

    const matchingRules = rules
      .filter((r) => r.reward_item_id === line.item_id)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    let remaining = line.qty;
    let discount = 0;
    let firstRuleId: string | null = null;
    for (const rule of matchingRules) {
      if (remaining <= 0) break;
      if (!pool.has(rule.id)) {
        const triggerQty = qtyByItem.get(rule.trigger_item_id) ?? 0;
        // trigger = reward (mis. "beli 2 gratis 1 barang yang sama"): qty pemicu & qty hadiah
        // adalah POOL UNIT FISIK YANG SAMA -- 1 "set" = (buy_qty+free_qty) unit total, BUKAN
        // buy_qty doang, atau unit yang udah digratiskan ikut jadi basis gratis berikutnya.
        const setSize = rule.trigger_item_id === rule.reward_item_id ? rule.buy_qty + rule.free_qty : rule.buy_qty;
        pool.set(rule.id, Math.floor(triggerQty / setSize) * rule.free_qty);
      }
      const take = Math.min(pool.get(rule.id) ?? 0, remaining);
      if (take <= 0) continue;
      discount += take * rewardDiscountPerUnit(rule, line.unit_price);
      remaining -= take;
      pool.set(rule.id, (pool.get(rule.id) ?? 0) - take);
      firstRuleId ??= rule.id;
    }

    if (discount > 0 && firstRuleId) {
      result.set(index, {
        bundle_promo_rule_id: firstRuleId,
        discount_amount: Math.round(discount * 100) / 100,
      });
    }
  });

  return result;
}
