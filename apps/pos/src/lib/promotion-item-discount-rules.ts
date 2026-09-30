/** Preview client-side dari trade discount (promotion_item_discount_rules) -- MURNI buat
 * tampilan kasir (hitung kembalian sebelum checkout dikonfirmasi), BUKAN otoritatif. Nilai yang
 * beneran dijurnal dihitung ULANG server-side di dalam RPC create_pos_sale lewat fungsi SQL
 * resolve_item_discount (supabase/migrations/0047_rename_promotion_rules_tables.sql) --
 * drift-risk 2-tempat yang disadari, pola sama report_cash_flow_investing_financing vs
 * reference implementation TS-nya (lihat memory/architecture/app/tech-stack-decisions.md).
 * Logic di bawah ini WAJIB tetap mirror apps/erp/src/lib/promotion-item-discount-rules/schema.ts
 * kalau salah satu diubah. Ref: docs/domain/accounts-receivable.md submodule "Diskon Penjualan
 * (Trade Discount)", docs/architecture/promotion-item-discount-rules-schema.md. */
import { supabase } from "./supabase/client";
import { getKeyValue, setKeyValue } from "./local-db";

export type ItemDiscountRule = {
  id: string;
  item_id: string | null;
  category_id: string | null;
  discount_type: "PERCENT" | "NOMINAL";
  discount_value: number;
};

// Pola sama fetchItemRows/fetchCustomers di page.tsx: coba online -> tulis-tembus ke cache
// keyValue -> gagal -> baca balik dari cache -> cache kosong -> lempar error apa adanya.
export async function fetchActiveItemDiscountRules(): Promise<ItemDiscountRule[]> {
  try {
    const { data, error } = await supabase
      .from("promotion_item_discount_rules")
      .select("id, item_id, category_id, discount_type, discount_value")
      .is("archived_at", null);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ItemDiscountRule[];
    await setKeyValue("promotion_item_discount_rules", rows);
    return rows;
  } catch (err) {
    const cached = await getKeyValue<ItemDiscountRule[]>("promotion_item_discount_rules");
    if (cached) return cached;
    throw err;
  }
}

export type ResolvedItemDiscount = { discount_rule_id: string; discount_amount: number };

/** Mirror persis resolveItemDiscount() di apps/erp. */
export function resolveItemDiscount(
  itemId: string,
  categoryId: string | null,
  qty: number,
  amount: number,
  rules: ItemDiscountRule[]
): ResolvedItemDiscount | null {
  const rule =
    rules.find((r) => r.item_id === itemId) ?? (categoryId ? rules.find((r) => r.category_id === categoryId) : undefined);
  if (!rule) return null;

  const raw = rule.discount_type === "PERCENT" ? (amount * rule.discount_value) / 100 : qty * rule.discount_value;
  const discount_amount = Math.min(Math.round(raw * 100) / 100, amount);
  if (discount_amount <= 0) return null;
  return { discount_rule_id: rule.id, discount_amount };
}
