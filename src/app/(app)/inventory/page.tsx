"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import { lotRemaining, type InventoryLot, type InventoryBalance } from "@/lib/inventory/schema";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

export default function InventoryPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [lots, setLots] = useState<InventoryLot[]>([]);
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const [itemsRes, lotsRes, balancesRes] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, costing_method, uom, inventory_account_id, archived_at")
        .order("name"),
      supabase
        .from("inventory_lots")
        .select("id, item_id, source_type, lot_date, qty_in, unit_cost, inventory_lot_consumptions(qty)")
        .order("lot_date"),
      supabase.from("inventory_balances").select("item_id, qty_on_hand, avg_cost"),
    ]);
    if (itemsRes.error) {
      setLoadError(itemsRes.error.message);
      return;
    }
    setLoadError(null);
    setItems((itemsRes.data ?? []) as Item[]);
    setLots((lotsRes.data ?? []) as unknown as InventoryLot[]);
    setBalances((balancesRes.data ?? []) as InventoryBalance[]);
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
    if (item.costing_method === "FIFO") {
      const value = lots
        .filter((l) => l.item_id === item.id)
        .reduce((s, l) => s + lotRemaining(l) * l.unit_cost, 0);
      return sum + value;
    }
    const balance = balances.find((b) => b.item_id === item.id);
    return sum + (balance ? balance.qty_on_hand * balance.avg_cost : 0);
  }, 0);

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Posisi Persediaan — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Kartu stok tiap item — FIFO per lot, Weighted Average rata-rata berjalan. Read-only,
          derived dari transaksi (PO/GRN/Production/Goods Issue).
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
              <th className="px-4 py-2">Metode</th>
              <th className="px-4 py-2">Rincian</th>
              <th className="px-4 py-2 text-right">Qty Tersisa</th>
              <th className="px-4 py-2 text-right">Nilai Persediaan</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              if (item.costing_method === "FIFO") {
                const itemLots = lots
                  .filter((l) => l.item_id === item.id)
                  .map((l) => ({ ...l, remaining: lotRemaining(l) }))
                  .filter((l) => l.remaining > 0);
                const totalQty = itemLots.reduce((sum, l) => sum + l.remaining, 0);
                const totalValue = itemLots.reduce((sum, l) => sum + l.remaining * l.unit_cost, 0);
                return (
                  <tr key={item.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium text-black">{item.name}</td>
                    <td className="px-4 py-2">FIFO</td>
                    <td className="px-4 py-2">
                      {itemLots.length === 0 ? (
                        <span className="text-slate-400">Stok kosong</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {itemLots.map((l) => (
                            <li key={l.id}>
                              {l.lot_date} — {l.remaining} {item.uom} @ {l.unit_cost.toLocaleString("id-ID")}
                              <span className="ml-1 text-xs text-slate-400">
                                ({l.source_type === "PURCHASE_RECEIPT" ? "beli" : "produksi"})
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {totalQty} {item.uom}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{totalValue.toLocaleString("id-ID")}</td>
                  </tr>
                );
              }

              const balance = balances.find((b) => b.item_id === item.id);
              const qty = balance?.qty_on_hand ?? 0;
              const avgCost = balance?.avg_cost ?? 0;
              return (
                <tr key={item.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-black">{item.name}</td>
                  <td className="px-4 py-2">Weighted Average</td>
                  <td className="px-4 py-2">
                    avg_cost {avgCost.toLocaleString("id-ID")}/{item.uom}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {qty} {item.uom}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{(qty * avgCost).toLocaleString("id-ID")}</td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada item.
                </td>
              </tr>
            )}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 font-medium text-black">
                <td colSpan={4} className="px-4 py-2 text-right">
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
