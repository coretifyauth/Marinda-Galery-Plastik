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
  /** Syarat minimal qty dalam SATUAN DASAR (diisi trigger DB). null/undefined (juga di cache offline lama) = tanpa syarat. */
  min_qty_base?: number | null;
};

// Pola sama fetchItemRows/fetchCustomers di page.tsx: coba online -> tulis-tembus ke cache
// keyValue -> gagal -> baca balik dari cache -> cache kosong -> lempar error apa adanya.
export async function fetchActiveItemDiscountRules(): Promise<ItemDiscountRule[]> {
  try {
    const { data, error } = await supabase
      .from("promotion_item_discount_rules")
      .select("id, item_id, category_id, discount_type, discount_value, min_qty_base")
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

/** Mirror persis resolveItemDiscount() di apps/erp (dan resolve_item_discount SQL, 0050): aturan
 * barang yang syarat minimalnya terpenuhi (tingkat tertinggi) menang atas kategori; kalau gak ada
 * yang terpenuhi, jatuh ke aturan kategori. `totalQty` = total qty satuan dasar barang ini lintas
 * SEMUA baris keranjang (cuma buat cek syarat); diskon dihitung ke baseQty/amount baris ini. */
export function resolveItemDiscount(
  itemId: string,
  categoryId: string | null,
  baseQty: number,
  amount: number,
  rules: ItemDiscountRule[],
  totalQty: number = baseQty
): ResolvedItemDiscount | null {
  const itemRule = rules
    .filter((r) => r.item_id === itemId && (r.min_qty_base ?? 0) <= totalQty)
    .sort((a, b) => (b.min_qty_base ?? 0) - (a.min_qty_base ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  const rule = itemRule ?? (categoryId ? rules.find((r) => r.category_id === categoryId) : undefined);
  if (!rule) return null;

  const raw = rule.discount_type === "PERCENT" ? (amount * rule.discount_value) / 100 : baseQty * rule.discount_value;
  const discount_amount = Math.min(Math.round(raw * 100) / 100, amount);
  if (discount_amount <= 0) return null;
  return { discount_rule_id: rule.id, discount_amount };
}
