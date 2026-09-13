"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { ProductionOrder } from "@/lib/production-orders/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { LoadingScreen } from "@/components/ui/loading-screen";

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

export function ProductionOrderDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [order, setOrder] = useState<ProductionOrder | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("lines");

  const load = useCallback(async () => {
    const { data: po, error: poErr } = await supabase
      .from("production_orders")
      .select(
        "id, bom_header_id, qty_produced, production_date, source_ref, journal_entry_id, created_at, bom_headers(items(name)), production_order_lines(id, item_id, qty_consumed, total_cost, items(name, uom))"
      )
      .eq("id", id)
      .single();
    if (poErr || !po) {
      setLoadError(poErr?.message ?? "Production order gak ditemukan.");
      return;
    }
    const loadedOrder = po as unknown as ProductionOrder;
    setOrder(loadedOrder);

    const { data: entries, error: entriesErr } = await supabase
      .from("journal_entries")
      .select(
        "id, entry_date, description, source_ref, journal_lines(id, debit, credit, accounts(code, name))"
      )
      .eq("id", loadedOrder.journal_entry_id)
      .order("entry_date");

    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setLoadError(entriesErr?.message ?? null);
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
    return <LoadingScreen />;
  }

  if (!order) {
    return <FormError>{loadError ?? "Production order gak ditemukan."}</FormError>;
  }

  const totalCost = order.production_order_lines.reduce((sum, l) => sum + l.total_cost, 0);

  const detailGroups = [
    {
      title: "Informasi Produksi",
      rows: [
        { label: "Barang Jadi", value: order.bom_headers.items.name },
        { label: "Rujukan Dokumen", value: order.source_ref },
        { label: "Tanggal Produksi", value: order.production_date },
        { label: "Qty Produksi", value: String(order.qty_produced) },
      ],
    },
    {
      title: "Ringkasan",
      rows: [{ label: "Total Biaya", value: totalCost.toLocaleString("id-ID") }],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Konsumsi Bahan Baku", badge: order.production_order_lines.length },
    { key: "jurnal", label: "Jurnal Terkait", badge: journalEntries.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/production-orders" label="Kembali ke Production Order" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Production Order</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {order.source_ref}
          </span>
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "lines" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Bahan Baku</th>
                <th className="px-4 py-2 text-right">Qty Dikonsumsi</th>
                <th className="px-4 py-2 text-right">Total Biaya</th>
              </tr>
            </thead>
            <tbody>
              {order.production_order_lines.map((line) => (
                <tr key={line.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-black">{line.items.name}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {line.qty_consumed} {line.items.uom}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{line.total_cost.toLocaleString("id-ID")}</td>
                </tr>
              ))}
              {order.production_order_lines.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                    Belum ada konsumsi bahan baku.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "jurnal" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Tanggal</th>
                <th className="px-4 py-2">Deskripsi</th>
                <th className="px-4 py-2">Rujukan Dokumen</th>
                <th className="px-4 py-2">Baris</th>
              </tr>
            </thead>
            <tbody>
              {journalEntries.map((entry) => (
                <tr key={entry.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">{entry.entry_date}</td>
                  <td className="px-4 py-2">{entry.description}</td>
                  <td className="px-4 py-2">{entry.source_ref}</td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5">
                      {entry.journal_lines.map((line) => (
                        <li key={line.id}>
                          {line.accounts.code} {line.accounts.name} —{" "}
                          {line.debit > 0
                            ? `D ${line.debit.toLocaleString("id-ID")}`
                            : `K ${line.credit.toLocaleString("id-ID")}`}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
              {journalEntries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    Belum ada jurnal.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
