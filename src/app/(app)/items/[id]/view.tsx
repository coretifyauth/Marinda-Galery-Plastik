"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { lotRemaining, type InventoryLot, type InventoryBalance } from "@/lib/inventory/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

export function ItemDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [item, setItem] = useState<Item | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lots, setLots] = useState<InventoryLot[]>([]);
  const [balance, setBalance] = useState<InventoryBalance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: it, error: itErr }, { data: acc }, { data: lt, error: ltErr }, { data: bal }] =
      await Promise.all([
        supabase
          .from("items")
          .select("id, name, item_type, costing_method, uom, inventory_account_id, archived_at")
          .eq("id", id)
          .single(),
        supabase
          .from("accounts")
          .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at"),
        supabase
          .from("inventory_lots")
          .select("id, item_id, source_type, lot_date, qty_in, unit_cost, inventory_lot_consumptions(qty)")
          .eq("item_id", id)
          .order("lot_date"),
        supabase.from("inventory_balances").select("item_id, qty_on_hand, avg_cost").eq("item_id", id).maybeSingle(),
      ]);
    if (itErr) {
      setLoadError(itErr.message);
      return;
    }
    setLoadError(ltErr?.message ?? null);
    setItem(it as Item);
    setAccounts((acc ?? []) as Account[]);
    setLots((lt ?? []) as unknown as InventoryLot[]);
    setBalance((bal as InventoryBalance) ?? null);
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!item) {
    return <FormError>{loadError ?? "Item gak ditemukan."}</FormError>;
  }

  const inventoryAccount = getLeafAccounts(accounts).find((a) => a.id === item.inventory_account_id);
  const totalQty =
    item.costing_method === "FIFO"
      ? lots.reduce((sum, l) => sum + lotRemaining(l), 0)
      : (balance?.qty_on_hand ?? 0);
  const totalValue =
    item.costing_method === "FIFO"
      ? lots.reduce((sum, l) => sum + lotRemaining(l) * l.unit_cost, 0)
      : (balance?.qty_on_hand ?? 0) * (balance?.avg_cost ?? 0);

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/items" label="Kembali ke Items" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-black">{item.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {item.item_type}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {item.costing_method}
            </span>
            <span className="text-sm text-slate-500">
              {inventoryAccount ? `${inventoryAccount.code} — ${inventoryAccount.name}` : "-"}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-slate-400">Nilai Persediaan</div>
          <div className="font-mono text-lg font-medium text-black">
            {totalValue.toLocaleString("id-ID")}
          </div>
          <div className="text-sm text-slate-500">
            {totalQty} {item.uom} tersisa
          </div>
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      {item.costing_method === "FIFO" ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-2">
            <span className="text-sm font-medium text-black">Kartu Stok (Lot FIFO)</span>
            <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {lots.length}
            </span>
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Tanggal</th>
                <th className="px-4 py-2">Sumber</th>
                <th className="px-4 py-2 text-right">Qty Masuk</th>
                <th className="px-4 py-2 text-right">Harga/Unit</th>
                <th className="px-4 py-2 text-right">Sisa</th>
                <th className="px-4 py-2 text-right">Nilai Sisa</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => {
                const remaining = lotRemaining(lot);
                return (
                  <tr key={lot.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2">{lot.lot_date}</td>
                    <td className="px-4 py-2">
                      {lot.source_type === "PURCHASE_RECEIPT" ? "Pembelian" : "Produksi"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{lot.qty_in}</td>
                    <td className="px-4 py-2 text-right font-mono">{lot.unit_cost.toLocaleString("id-ID")}</td>
                    <td className="px-4 py-2 text-right font-mono">{remaining}</td>
                    <td className="px-4 py-2 text-right font-mono">
                      {(remaining * lot.unit_cost).toLocaleString("id-ID")}
                    </td>
                  </tr>
                );
              })}
              {lots.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                    Belum ada lot buat item ini.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="mb-4 text-sm text-slate-500">
            Weighted Average gak nyimpen riwayat per-batch — cuma 1 angka rata-rata berjalan,
            dihitung ulang tiap ada penerimaan baru (ref <code>docs/domain/human/inventory.md</code>).
          </p>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs uppercase text-slate-400">Qty On Hand</dt>
              <dd className="font-mono text-black">
                {balance?.qty_on_hand ?? 0} {item.uom}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-400">Avg Cost / {item.uom}</dt>
              <dd className="font-mono text-black">{(balance?.avg_cost ?? 0).toLocaleString("id-ID")}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
