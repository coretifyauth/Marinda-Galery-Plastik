/** Preview client-side dari Bundle Promo (bundle_promo_rules) -- MURNI buat tampilan kasir,
 * BUKAN otoritatif. Nilai yang beneran dijurnal dihitung ULANG server-side di dalam RPC
 * create_pos_sale lewat fungsi SQL resolve_bundle_promo_discounts
 * (supabase/migrations/0046_bundle_promo_rules_schema.sql) -- drift-risk 2-tempat yang
 * disadari, sama pola item-discount-rules.ts. Logic di bawah WAJIB tetap mirror
 * apps/erp/src/lib/bundle-promo-rules/schema.ts kalau salah satu diubah. Ref:
 * docs/domain/accounts-receivable.md submodule "Beli N Gratis X (Bundle Promo)",
 * docs/architecture/bundle-promo-rules-schema.md. */
import { supabase } from "./supabase/client";
import { getKeyValue, setKeyValue } from "./local-db";

export type BundlePromoRule = {
  id: string;
  trigger_item_id: string;
  buy_qty: number;
  reward_item_id: string;
  free_qty: number;
};

export async function fetchActiveBundlePromoRules(): Promise<BundlePromoRule[]> {
  try {
    const { data, error } = await supabase
      .from("bundle_promo_rules")
      .select("id, trigger_item_id, buy_qty, reward_item_id, free_qty")
      .is("archived_at", null);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as BundlePromoRule[];
    await setKeyValue("bundle_promo_rules", rows);
    return rows;
  } catch (err) {
    const cached = await getKeyValue<BundlePromoRule[]>("bundle_promo_rules");
    if (cached) return cached;
    throw err;
  }
}

export type BundlePromoLineInput = { item_id: string; qty: number; unit_price: number };
export type ResolvedBundlePromo = { bundle_promo_rule_id: string; discount_amount: number };

/** Mirror persis resolveBundlePromoDiscounts() di apps/erp (termasuk kasus khusus
 * trigger_item_id = reward_item_id: 1 "set" = buy_qty+free_qty unit, bukan buy_qty doang --
 * kalau tidak, unit yang udah digratiskan ikut kehitung lagi jadi basis gratis berikutnya). */
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
