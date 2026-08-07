"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Item } from "@/lib/items/schema";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { InventoryBalance } from "@/lib/inventory/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

export function ItemDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [item, setItem] = useState<Item | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balance, setBalance] = useState<InventoryBalance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: it, error: itErr }, { data: acc }, { data: bal }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, archived_at")
        .eq("id", id)
        .single(),
      supabase
        .from("accounts")
        .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at"),
      supabase.from("inventory_balances").select("item_id, qty_on_hand, avg_cost").eq("item_id", id).maybeSingle(),
    ]);
    if (itErr) {
      setLoadError(itErr.message);
      return;
    }
    setLoadError(null);
    setItem(it as Item);
    setAccounts((acc ?? []) as Account[]);
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
  const totalQty = balance?.qty_on_hand ?? 0;
  const totalValue = (balance?.qty_on_hand ?? 0) * (balance?.avg_cost ?? 0);

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

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="mb-4 text-sm text-slate-500">
          Weighted Average gak nyimpen riwayat per-batch — cuma 1 angka rata-rata berjalan,
          dihitung ulang tiap ada penerimaan baru (ref <code>docs/domain/inventory.md</code>).
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
    </div>
  );
}
