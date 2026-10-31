import { supabase } from "@/lib/supabase/client";
import { findPriceDeviations, PRICE_DEVIATION_LIMIT, type PriceCheckLine } from "./calc";

/**
 * Harga jauh dari rata-rata stok biasanya salah ketik atau salah satuan (harga per dus diisi per pcs). Peringatan, bukan
 * penolakan: harga supplier memang bisa berubah. Mengembalikan true kalau boleh lanjut.
 */
export async function confirmPriceDeviations(lines: PriceCheckLine[]): Promise<boolean> {
  if (lines.length === 0) return true;
  const { data, error } = await supabase
    .from("inventory_balances")
    .select("item_id, avg_cost")
    .in("item_id", lines.map((l) => l.itemId));
  if (error) return true;
  const avgCosts = new Map(((data ?? []) as { item_id: string; avg_cost: number }[]).map((b) => [b.item_id, b.avg_cost]));
  const deviations = findPriceDeviations(lines, avgCosts);
  if (deviations.length === 0) return true;
  const rupiah = (n: number) => `Rp${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;
  const detail = deviations
    .map((d) => `- ${d.itemName}: ${rupiah(d.netUnitCost)} per satuan dasar, rata-rata stok ${rupiah(d.avgCost)}`)
    .join("\n");
  return window.confirm(`Harga berikut beda lebih dari ${PRICE_DEVIATION_LIMIT * 100}% dari rata-rata stok:\n${detail}\n\nCek harga dan satuannya. Tetap simpan?`);
}
