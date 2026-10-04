/** Preview client-side dari Bundle Promo (promotion_bundle_rules) -- MURNI buat tampilan
 * kasir, BUKAN otoritatif. Nilai yang beneran dijurnal dihitung ULANG server-side di dalam RPC
 * create_pos_sale lewat fungsi SQL resolve_bundle_promo_discounts
 * (supabase/migrations/0047_rename_promotion_rules_tables.sql) -- drift-risk 2-tempat yang
 * disadari, sama pola promotion-item-discount-rules.ts. Logic di bawah WAJIB tetap mirror
 * apps/erp/src/lib/promotion-bundle-rules/schema.ts kalau salah satu diubah. Ref:
 * docs/domain/accounts-receivable.md submodule "Beli N Gratis X (Bundle Promo)",
 * docs/architecture/promotion-bundle-rules-schema.md. */
import { supabase } from "./supabase/client";
import { getKeyValue, setKeyValue } from "./local-db";

export type BundlePromoRule = {
  id: string;
  trigger_item_id: string;
  buy_qty: number;
  reward_item_id: string;
  free_qty: number;
  /** FREE (harga jadi Rp0) / PERCENT / NOMINAL (Rp per satuan dasar barang hadiah). Cache offline lama belum punya -> FREE. */
  reward_type?: "FREE" | "PERCENT" | "NOMINAL";
  reward_value?: number | null;
};

export async function fetchActiveBundlePromoRules(): Promise<BundlePromoRule[]> {
  try {
    const { data, error } = await supabase
      .from("promotion_bundle_rules")
      .select("id, trigger_item_id, buy_qty, reward_item_id, free_qty, reward_type, reward_value")
      .is("archived_at", null);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as BundlePromoRule[];
    await setKeyValue("promotion_bundle_rules", rows);
    return rows;
  } catch (err) {
    const cached = await getKeyValue<BundlePromoRule[]>("promotion_bundle_rules");
    if (cached) return cached;
    throw err;
  }
}

export type BundlePromoLineInput = { item_id: string; qty: number; unit_price: number };
export type ResolvedBundlePromo = { bundle_promo_rule_id: string; discount_amount: number };

/** Diskon per 1 unit satuan dasar barang hadiah menurut jenis hadiah. */
function rewardDiscountPerUnit(rule: BundlePromoRule, unitPrice: number): number {
  switch (rule.reward_type ?? "FREE") {
    case "PERCENT":
      return (unitPrice * (rule.reward_value ?? 0)) / 100;
    case "NOMINAL":
      return Math.min(rule.reward_value ?? 0, unitPrice);
    default:
      return unitPrice;
  }
}

/** Mirror persis resolveBundlePromoDiscounts() di apps/erp (dan resolve_bundle_promo_discounts SQL,
 * 0050): jatah hadiah tiap aturan = POOL yang dibagi berurutan antar baris (barang hadiah di >1
 * baris gak bisa ngeklaim jatah penuh masing-masing), jenis hadiah FREE/PERCENT/NOMINAL, baris
 * berharga 0 dilewati, dan kasus khusus trigger_item_id = reward_item_id: 1 "set" = buy_qty+free_qty
 * unit, bukan buy_qty doang -- kalau tidak, unit yang udah digratiskan ikut kehitung lagi jadi basis
 * gratis berikutnya. */
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
      result.set(index, { bundle_promo_rule_id: firstRuleId, discount_amount: Math.round(discount * 100) / 100 });
    }
  });

  return result;
}
