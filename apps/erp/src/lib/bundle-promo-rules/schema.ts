import { z } from "zod";
import { supabase } from "@/lib/supabase/client";

/** Ref: docs/domain/accounts-receivable.md submodule "Beli N Gratis X (Bundle Promo)",
 * docs/architecture/bundle-promo-rules-schema.md. Mirror SQL: resolve_bundle_promo_discounts
 * (supabase/migrations/0046_bundle_promo_rules_schema.sql), dipakai create_pos_sale
 * server-side -- versi TypeScript ini dipakai sisi admin (client-computed, RPC trust) DAN
 * preview tampilan POS (non-otoritatif, lihat apps/pos). */
export const bundlePromoRuleSchema = z.object({
  name: z.string().min(1, "Nama promo wajib diisi"),
  trigger_item_id: z.string().uuid("Pilih barang pemicu"),
  buy_qty: z.coerce.number().positive("Qty beli harus lebih dari 0"),
  reward_item_id: z.string().uuid("Pilih barang hadiah"),
  free_qty: z.coerce.number().positive("Qty gratis harus lebih dari 0"),
});

export type BundlePromoRule = {
  id: string;
  name: string;
  trigger_item_id: string;
  buy_qty: number;
  reward_item_id: string;
  free_qty: number;
  archived_at: string | null;
};

export async function fetchActiveBundlePromoRules(): Promise<BundlePromoRule[]> {
  const { data } = await supabase
    .from("bundle_promo_rules")
    .select("id, name, trigger_item_id, buy_qty, reward_item_id, free_qty, archived_at")
    .is("archived_at", null);
  return (data ?? []) as BundlePromoRule[];
}

export type BundlePromoLineInput = { item_id: string; qty: number; unit_price: number };
export type ResolvedBundlePromo = { bundle_promo_rule_id: string; discount_amount: number };

/**
 * Resolusi cart-wide: (1) jumlahkan qty per item_id lintas SEMUA baris (basis qty pemicu),
 * (2) per baris, kalau item baris itu reward_item_id dari 1+ aturan aktif, hitung total qty
 * gratis (floor(triggerQty/buy_qty)*free_qty per aturan, diakumulasi kalau >1 aturan match
 * reward yang sama), dibatasi qty baris itu sendiri. Return map index-baris -> hasil resolusi
 * (index yang gak match gak muncul di map). Mirror persis resolve_bundle_promo_discounts SQL.
 */
export function resolveBundlePromoDiscounts(
  lines: BundlePromoLineInput[],
  rules: BundlePromoRule[]
): Map<number, ResolvedBundlePromo> {
  const qtyByItem = new Map<string, number>();
  for (const line of lines) {
    qtyByItem.set(line.item_id, (qtyByItem.get(line.item_id) ?? 0) + line.qty);
  }

  const result = new Map<number, ResolvedBundlePromo>();
  lines.forEach((line, index) => {
    const matchingRules = rules.filter((r) => r.reward_item_id === line.item_id);
    if (matchingRules.length === 0) return;

    let earned = 0;
    for (const rule of matchingRules) {
      const triggerQty = qtyByItem.get(rule.trigger_item_id) ?? 0;
      // trigger = reward (mis. "beli 2 gratis 1 barang yang sama"): qty pemicu & qty hadiah
      // adalah POOL UNIT FISIK YANG SAMA -- 1 "set" berarti (buy_qty+free_qty) unit total,
      // BUKAN buy_qty doang, atau unit yang udah digratiskan ikut jadi basis gratis
      // berikutnya (over-grant). trigger != reward: pool-nya independen, tetap
      // floor(triggerQty/buy_qty) seperti biasa.
      const setSize = rule.trigger_item_id === rule.reward_item_id ? rule.buy_qty + rule.free_qty : rule.buy_qty;
      earned += Math.floor(triggerQty / setSize) * rule.free_qty;
    }

    const cappedQty = Math.min(earned, line.qty);
    if (cappedQty <= 0) return;

    result.set(index, {
      bundle_promo_rule_id: [...matchingRules].sort((a, b) => a.id.localeCompare(b.id))[0].id,
      discount_amount: Math.round(cappedQty * line.unit_price * 100) / 100,
    });
  });

  return result;
}
