"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type PosSaleRow = {
  id: string;
  sale_date: string;
  source_ref: string;
  revenue_journal_entry_id: string;
  customers: { name: string } | null;
  cash_account: { code: string; name: string } | null;
  pos_sale_lines: { line_amount: number }[];
};

export default function PosSalesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [sales, setSales] = useState<PosSaleRow[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("pos_sales")
      .select(
        "id, sale_date, source_ref, revenue_journal_entry_id, customers(name), cash_account:accounts!cash_account_id(code, name), pos_sale_lines(line_amount)"
      )
      .order("sale_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setSales((data ?? []) as unknown as PosSaleRow[]);

    const { data: reversals } = await supabase
      .from("journal_entries")
      .select("reverses_entry_id")
      .not("reverses_entry_id", "is", null);
    setReversedEntryIds(
      new Set(((reversals ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      if (!active) return;
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

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">POS Sales</h1>
        <p className="text-sm text-slate-500">
          Riwayat penjualan tunai kios — transaksi dibuat lewat aplikasi kasir (apps/pos), bukan di sini.
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">POS Sales</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {sales.length}
            </span>
          </div>
          <Button variant="toolbar" onClick={() => load()}>
            Refresh
          </Button>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Pelanggan</th>
              <th className="px-4 py-2">Metode Bayar</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => {
              const total = s.pos_sale_lines.reduce((sum, l) => sum + l.line_amount, 0);
              const isCancelled = reversedEntryIds.has(s.revenue_journal_entry_id);
              return (
                <tr
                  key={s.id}
                  className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                  onClick={() => router.push(`/pos-sales/${s.id}`)}
                >
                  <td className="whitespace-nowrap px-4 py-2">{s.sale_date}</td>
                  <td className="px-4 py-2">{s.source_ref}</td>
                  <td className="px-4 py-2">{s.customers?.name ?? "Walk-in"}</td>
                  <td className="px-4 py-2">{s.cash_account?.name ?? "—"}</td>
                  <td className="px-4 py-2 text-right font-mono">{total.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2">
                    {isCancelled ? (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">
                        Dibatalkan
                      </span>
                    ) : (
                      <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
                        Normal
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {sales.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada transaksi POS.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
