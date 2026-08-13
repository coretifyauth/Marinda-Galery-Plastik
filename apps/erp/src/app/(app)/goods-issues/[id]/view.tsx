"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";

type GoodsIssueDetail = {
  id: string;
  invoice_id: string;
  journal_entry_id: string;
  issue_date: string;
  source_ref: string;
  created_at: string;
  ar_invoices: { source_ref: string; amount: number; customers: { name: string } };
  goods_issue_lines: {
    id: string;
    qty_issued: number;
    total_cost: number;
    items: { name: string; uom: string };
  }[];
};

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

export function GoodsIssueDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [issue, setIssue] = useState<GoodsIssueDetail | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("jurnal");

  const load = useCallback(async () => {
    const { data: gi, error: giErr } = await supabase
      .from("goods_issues")
      .select(
        "id, invoice_id, journal_entry_id, issue_date, source_ref, created_at, ar_invoices(source_ref, amount, customers(name)), goods_issue_lines(id, qty_issued, total_cost, items(name, uom))"
      )
      .eq("id", id)
      .single();
    if (giErr || !gi) {
      setLoadError(giErr?.message ?? "Goods issue gak ditemukan.");
      return;
    }
    const loadedIssue = gi as unknown as GoodsIssueDetail;
    setIssue(loadedIssue);

    const { data: entries, error: entriesErr } = await supabase
      .from("journal_entries")
      .select("id, entry_date, description, source_ref, journal_lines(id, debit, credit, accounts(code, name))")
      .eq("id", loadedIssue.journal_entry_id)
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

  if (!issue) {
    return <FormError>{loadError ?? "Goods issue gak ditemukan."}</FormError>;
  }

  const totalHpp = issue.goods_issue_lines.reduce((sum, l) => sum + l.total_cost, 0);

  const detailGroups = [
    {
      title: "Informasi Goods Issue",
      rows: [
        { label: "Customer", value: issue.ar_invoices.customers.name },
        { label: "Rujukan Dokumen", value: issue.source_ref },
        { label: "Tanggal", value: issue.issue_date },
        {
          label: "Invoice Terkait",
          value: (
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => router.push(`/ar-invoices/${issue.invoice_id}`)}
            >
              {issue.ar_invoices.source_ref}
            </button>
          ),
        },
        { label: "Pendapatan Invoice", value: issue.ar_invoices.amount.toLocaleString("id-ID") },
      ],
    },
    {
      title: "Ringkasan",
      rows: [{ label: "Total HPP", value: totalHpp.toLocaleString("id-ID") }],
    },
  ];

  const tabs: TabDef[] = [
    { key: "jurnal", label: "Jurnal HPP Terkait", badge: journalEntries.length },
    { key: "lines", label: "Barang Keluar", badge: issue.goods_issue_lines.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/goods-issues" label="Kembali ke Goods Issues" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Goods Issue Details</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {issue.source_ref}
          </span>
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

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

      {activeTab === "lines" && (
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2 text-right">Qty</th>
              <th className="px-4 py-2 text-right">Total HPP</th>
            </tr>
          </thead>
          <tbody>
            {issue.goods_issue_lines.map((l) => (
              <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2">{l.items.name}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {l.qty_issued} {l.items.uom}
                </td>
                <td className="px-4 py-2 text-right font-mono">{l.total_cost.toLocaleString("id-ID")}</td>
              </tr>
            ))}
            {issue.goods_issue_lines.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                  Belum ada baris.
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
