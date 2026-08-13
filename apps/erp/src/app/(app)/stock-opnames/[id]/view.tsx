"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { StockOpname } from "@/lib/stock-opnames/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

export function StockOpnameDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [opname, setOpname] = useState<StockOpname | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("lines");

  const load = useCallback(async () => {
    const { data: o, error: oErr } = await supabase
      .from("stock_opnames")
      .select(
        "id, opname_date, source_ref, created_at, stock_opname_lines(id, item_id, qty_system, qty_actual, unit_cost, journal_entry_id, items(name, uom))"
      )
      .eq("id", id)
      .single();
    if (oErr || !o) {
      setLoadError(oErr?.message ?? "Sesi opname gak ditemukan.");
      return;
    }
    const loadedOpname = o as unknown as StockOpname;
    setOpname(loadedOpname);

    const journalEntryIds = loadedOpname.stock_opname_lines.map((l) => l.journal_entry_id);
    if (journalEntryIds.length > 0) {
      const { data: entries, error: entriesErr } = await supabase
        .from("journal_entries")
        .select("id, entry_date, description, source_ref, journal_lines(id, debit, credit, accounts(code, name))")
        .in("id", journalEntryIds)
        .order("entry_date");
      setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
      setLoadError(entriesErr?.message ?? null);
    } else {
      setJournalEntries([]);
      setLoadError(null);
    }
  }, [id]);

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

  if (!opname) {
    return <FormError>{loadError ?? "Sesi opname gak ditemukan."}</FormError>;
  }

  const totalShortageValue = opname.stock_opname_lines
    .filter((l) => l.qty_actual < l.qty_system)
    .reduce((sum, l) => sum + (l.qty_system - l.qty_actual) * l.unit_cost, 0);
  const totalSurplusValue = opname.stock_opname_lines
    .filter((l) => l.qty_actual > l.qty_system)
    .reduce((sum, l) => sum + (l.qty_actual - l.qty_system) * l.unit_cost, 0);

  const detailGroups = [
    {
      title: "Informasi Sesi Opname",
      rows: [
        { label: "Rujukan Dokumen", value: opname.source_ref },
        { label: "Tanggal Opname", value: opname.opname_date },
      ],
    },
    {
      title: "Ringkasan Selisih",
      rows: [
        { label: "Beban Selisih (kurang)", value: totalShortageValue.toLocaleString("id-ID") },
        { label: "Pendapatan Selisih (lebih)", value: totalSurplusValue.toLocaleString("id-ID") },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Item Ada Selisih", badge: opname.stock_opname_lines.length },
    { key: "jurnal", label: "Jurnal Terkait", badge: journalEntries.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/stock-opnames" label="Kembali ke Stock Opname" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Stock Opname Details</h1>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "lines" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2 text-right">Qty Sistem</th>
                <th className="px-4 py-2 text-right">Qty Hasil Hitung</th>
                <th className="px-4 py-2 text-right">Selisih</th>
                <th className="px-4 py-2 text-right">Nilai</th>
              </tr>
            </thead>
            <tbody>
              {opname.stock_opname_lines.map((l) => {
                const variance = l.qty_actual - l.qty_system;
                const value = Math.abs(variance) * l.unit_cost;
                return (
                  <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-2">{l.items.name}</td>
                    <td className="px-4 py-2 text-right font-mono">
                      {l.qty_system} {l.items.uom}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {l.qty_actual} {l.items.uom}
                    </td>
                    <td
                      className={`px-4 py-2 text-right font-mono ${variance < 0 ? "text-red-600" : "text-emerald-600"}`}
                    >
                      {variance > 0 ? "+" : ""}
                      {variance} {l.items.uom}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{value.toLocaleString("id-ID")}</td>
                  </tr>
                );
              })}
              {opname.stock_opname_lines.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                    Belum ada baris.
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
                <th className="px-4 py-2">Source Ref</th>
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
