"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Button } from "@/components/ui/button";
import { CancelledBadge, CancelledBanner } from "@/components/ui/cancelled";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { LoadingScreen } from "@/components/ui/loading-screen";

type GoodsIssueDetail = {
  id: string;
  transaction_id: string;
  journal_entry_id: string;
  note_date: string;
  source_ref: string;
  created_at: string;
  ar_invoices: { source_ref: string; amount: number; status: string; counterparties: { name: string } };
  goods_note_lines: {
    id: string;
    qty: number;
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
  const [roles, setRoles] = useState<string[]>([]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    const { data: gi, error: giErr } = await supabase
      .from("goods_notes")
      .select(
        "id, transaction_id, journal_entry_id, note_date, source_ref, created_at, ar_invoices:transactions(source_ref, amount, status, counterparties(name)), goods_note_lines(id, qty, total_cost, items(name, uom))"
      )
      .eq("id", id)
      .eq("type", "OUTBOUND")
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
      const { data: roleRows } = await supabase
        .from("app_user_roles")
        .select("role_name")
        .eq("user_id", session.user.id);
      if (!active) return;
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  // Barang keluar dan invoice-nya dibuat 1 RPC, jadi dibatalkan juga lewat 1 RPC (cancel_ar_invoice):
  // jurnal invoice + HPP dibalik, stok dikembalikan, qty SO dibebaskan.
  async function handleCancel() {
    if (!issue) return;
    if (
      !window.confirm(
        `Batalkan barang keluar ${issue.ar_invoices.source_ref}? Stok barang akan dikembalikan dan invoice (Rp${issue.ar_invoices.amount.toLocaleString("id-ID")}) ikut dibatalkan.`
      )
    )
      return;

    setCancelError(null);
    setCancelling(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("journal_entries");
    } catch (err) {
      setCancelling(false);
      setCancelError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("cancel_ar_invoice", {
      p_invoice_id: issue.transaction_id,
      p_entry_date: new Date().toISOString().slice(0, 10),
      p_source_ref: sourceRef,
    });
    setCancelling(false);
    if (error) {
      setCancelError(error.message);
      return;
    }
    await load();
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!issue) {
    return <FormError>{loadError ?? "Goods issue gak ditemukan."}</FormError>;
  }

  const totalHpp = issue.goods_note_lines.reduce((sum, l) => sum + l.total_cost, 0);
  const isCancelled = issue.ar_invoices.status === "dibatalkan";
  const canCancel = !isCancelled && (roles.includes("admin") || roles.includes("accountant"));

  const detailGroups = [
    {
      title: "Informasi Barang Keluar",
      rows: [
        { label: "Pelanggan", value: issue.ar_invoices.counterparties.name },
        { label: "Rujukan Dokumen", value: issue.source_ref },
        { label: "Tanggal", value: issue.note_date },
        {
          label: "Invoice Terkait",
          value: (
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => router.push(`/ar-invoices/${issue.transaction_id}`)}
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
    { key: "lines", label: "Barang Keluar", badge: issue.goods_note_lines.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/goods-issues" label="Kembali ke Barang Keluar" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Barang Keluar</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {issue.source_ref}
          </span>
          {isCancelled && <CancelledBadge />}
        </div>
        {canCancel && (
          <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? "Membatalkan..." : "Batalkan Barang Keluar"}
          </Button>
        )}
      </div>

      {isCancelled && (
        <CancelledBanner>
          barang keluar ini tidak valid. Stok sudah dikembalikan dan invoice-nya dibatalkan.
        </CancelledBanner>
      )}
      {loadError && <FormError>{loadError}</FormError>}
      {cancelError && <FormError>{cancelError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

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
            {issue.goods_note_lines.map((l) => (
              <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2">{l.items.name}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {l.qty} {l.items.uom}
                </td>
                <td className="px-4 py-2 text-right font-mono">{l.total_cost.toLocaleString("id-ID")}</td>
              </tr>
            ))}
            {issue.goods_note_lines.length === 0 && (
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
