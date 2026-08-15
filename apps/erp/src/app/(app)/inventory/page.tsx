"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import type { InventoryBalance } from "@/lib/inventory/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { formatStockBreakdown } from "@/lib/stock-display";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

export default function InventoryPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const [itemsRes, balancesRes, itemUnitsRes] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, archived_at")
        .order("name"),
      supabase.from("inventory_balances").select("item_id, qty_on_hand, avg_cost"),
      supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
    ]);
    if (itemsRes.error) {
      setLoadError(itemsRes.error.message);
      return;
    }
    setLoadError(null);
    setItems((itemsRes.data ?? []) as Item[]);
    setBalances((balancesRes.data ?? []) as InventoryBalance[]);
    setItemUnits((itemUnitsRes.data ?? []) as ItemUnit[]);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await loadAll();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAll]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const grandTotal = items.reduce((sum, item) => {
    const balance = balances.find((b) => b.item_id === item.id);
    return sum + (balance ? balance.qty_on_hand * balance.avg_cost : 0);
  }, 0);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Posisi Persediaan</h1>
        <p className="text-sm text-slate-500">
          Kartu stok tiap item — Weighted Average rata-rata berjalan. Read-only, derived dari
          transaksi (PO/GRN/Production/Goods Issue).
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Persediaan</span>
          <Button variant="toolbar" onClick={() => loadAll()}>
            Refresh
          </Button>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2">Avg Cost</th>
              <th className="px-4 py-2 text-right">Qty Tersisa</th>
              <th className="px-4 py-2 text-right">Nilai Persediaan</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const balance = balances.find((b) => b.item_id === item.id);
              const qty = balance?.qty_on_hand ?? 0;
              const avgCost = balance?.avg_cost ?? 0;
              const unitsForItem = itemUnits.filter((u) => u.item_id === item.id);
              return (
                <tr key={item.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-black">{item.name}</td>
                  <td className="px-4 py-2">
                    {avgCost.toLocaleString("id-ID")}/{item.uom}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {formatStockBreakdown(qty, item.uom, unitsForItem)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{(qty * avgCost).toLocaleString("id-ID")}</td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada item.
                </td>
              </tr>
            )}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 font-medium text-black">
                <td colSpan={3} className="px-4 py-2 text-right">
                  Total Nilai Persediaan
                </td>
                <td className="px-4 py-2 text-right font-mono">{grandTotal.toLocaleString("id-ID")}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
