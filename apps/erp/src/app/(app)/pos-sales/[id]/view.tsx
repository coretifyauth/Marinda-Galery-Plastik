"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";

type PosSaleDetail = {
  id: string;
  sale_date: string;
  source_ref: string;
  revenue_journal_entry_id: string;
  cogs_journal_entry_id: string;
  customers: { name: string } | null;
  cash_account: { code: string; name: string } | null;
  revenue_account: { code: string; name: string } | null;
  pos_sale_lines: {
    id: string;
    qty_sold: number;
    unit_price: number;
    line_amount: number;
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

export function PosSaleDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [sale, setSale] = useState<PosSaleDetail | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [isCancelled, setIsCancelled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [activeTab, setActiveTab] = useState("lines");

  const load = useCallback(async () => {
    const { data: s, error: sErr } = await supabase
      .from("pos_sales")
      .select(
        "id, sale_date, source_ref, revenue_journal_entry_id, cogs_journal_entry_id, customers(name), cash_account:accounts!cash_account_id(code, name), revenue_account:accounts!revenue_account_id(code, name), pos_sale_lines(id, qty_sold, unit_price, line_amount, total_cost, items(name, uom))"
      )
      .eq("id", id)
      .single();
    if (sErr || !s) {
      setLoadError(sErr?.message ?? "POS sale gak ditemukan.");
      return;
    }
    const loadedSale = s as unknown as PosSaleDetail;
    setSale(loadedSale);

    const { data: entries, error: entriesErr } = await supabase
      .from("journal_entries")
      .select("id, entry_date, description, source_ref, journal_lines(id, debit, credit, accounts(code, name))")
      .in("id", [loadedSale.revenue_journal_entry_id, loadedSale.cogs_journal_entry_id])
      .order("entry_date");
    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setLoadError(entriesErr?.message ?? null);

    const { data: reversal } = await supabase
      .from("journal_entries")
      .select("id")
      .eq("reverses_entry_id", loadedSale.revenue_journal_entry_id)
      .maybeSingle();
    setIsCancelled(!!reversal);
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      const { data: roleRows } = await supabase
        .from("user_roles")
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

  async function handleVoid() {
    if (!sale) return;
    if (!window.confirm(`Batalkan transaksi POS ${sale.source_ref}?`)) return;

    setCancelError(null);
    setCancelling(true);
    let ref: string;
    try {
      ref = await generateDocumentNumber("journal_entries");
    } catch (err) {
      setCancelling(false);
      setCancelError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("void_pos_sale", {
      p_sale_id: sale.id,
      p_entry_date: new Date().toISOString().slice(0, 10),
      p_source_ref: ref,
    });
    setCancelling(false);
    if (error) {
      setCancelError(error.message);
      return;
    }
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!sale) {
    return <FormError>{loadError ?? "POS sale gak ditemukan."}</FormError>;
  }

  const total = sale.pos_sale_lines.reduce((sum, l) => sum + l.line_amount, 0);
  const totalCost = sale.pos_sale_lines.reduce((sum, l) => sum + l.total_cost, 0);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canVoid = canWrite && !isCancelled;

  const detailGroups = [
    {
      title: "Informasi Transaksi",
      rows: [
        { label: "Pelanggan", value: sale.customers?.name ?? "Walk-in (anonim)" },
        { label: "Rujukan Dokumen", value: sale.source_ref },
        { label: "Tanggal", value: sale.sale_date },
        { label: "Bayar via", value: sale.cash_account?.name ?? "—" },
        { label: "Akun Pendapatan", value: sale.revenue_account?.name ?? "—" },
        {
          label: "Status",
          value: isCancelled ? (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">Dibatalkan</span>
          ) : (
            <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">Normal</span>
          ),
        },
      ],
    },
    {
      title: "Ringkasan",
      rows: [
        { label: "Total", value: total.toLocaleString("id-ID") },
        { label: "Total HPP", value: totalCost.toLocaleString("id-ID") },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Barang Terjual", badge: sale.pos_sale_lines.length },
    { key: "jurnal", label: "Jurnal Terkait", badge: journalEntries.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/pos-sales" label="Kembali ke POS Sales" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">POS Sale Details</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {sale.source_ref}
          </span>
        </div>
        {canVoid && (
          <Button variant="toolbar" onClick={handleVoid} disabled={cancelling}>
            {cancelling ? "Membatalkan..." : "Batalkan"}
          </Button>
        )}
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {cancelError && <FormError>{cancelError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "lines" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2 text-right">Qty</th>
                <th className="px-4 py-2 text-right">Harga Satuan</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 text-right">HPP</th>
              </tr>
            </thead>
            <tbody>
              {sale.pos_sale_lines.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">{l.items.name}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {l.qty_sold} {l.items.uom}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{l.unit_price.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2 text-right font-mono">{l.line_amount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2 text-right font-mono">{l.total_cost.toLocaleString("id-ID")}</td>
                </tr>
              ))}
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
