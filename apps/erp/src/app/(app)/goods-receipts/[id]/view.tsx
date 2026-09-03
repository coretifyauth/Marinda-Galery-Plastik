"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { GoodsReceiptNote } from "@/lib/goods-receipts/schema";
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

export function GoodsReceiptDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [grn, setGrn] = useState<GoodsReceiptNote | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("lines");

  const load = useCallback(async () => {
    const { data: grnData, error: grnErr } = await supabase
      .from("goods_receipt_notes")
      .select(
        "id, purchase_order_id, bill_id, delivery_note_ref, receipt_date, created_at, purchase_orders(source_ref, suppliers(name)), ap_bills(source_ref, amount, journal_entry_id, suppliers(name)), goods_receipt_lines(id, item_id, qty_received, unit_cost, items(name, uom))"
      )
      .eq("id", id)
      .single();
    if (grnErr || !grnData) {
      setLoadError(grnErr?.message ?? "Goods receipt gak ditemukan.");
      return;
    }
    const loaded = grnData as unknown as GoodsReceiptNote & { ap_bills: { journal_entry_id: string } };
    setGrn(loaded);

    const { data: entries, error: entriesErr } = await supabase
      .from("journal_entries")
      .select(
        "id, entry_date, description, source_ref, journal_lines(id, debit, credit, accounts(code, name))"
      )
      .eq("id", loaded.ap_bills.journal_entry_id)
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
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!grn) {
    return <FormError>{loadError ?? "Goods receipt gak ditemukan."}</FormError>;
  }

  const detailGroups = [
    {
      title: "Informasi Penerimaan",
      rows: [
        { label: "Tanggal Terima", value: grn.receipt_date },
        { label: "No. Surat Jalan", value: grn.delivery_note_ref ?? "-" },
        {
          label: "Purchase Order",
          value: grn.purchase_orders ? (
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => router.push(`/purchase-orders/${grn.purchase_order_id}`)}
            >
              {grn.purchase_orders.source_ref}
            </button>
          ) : (
            <span className="text-slate-400">— (langsung tanpa PO)</span>
          ),
        },
        {
          label: "Supplier",
          value: grn.purchase_orders?.suppliers.name ?? grn.ap_bills.suppliers.name,
        },
        {
          label: "Bill",
          value: (
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => router.push(`/ap-bills/${grn.bill_id}`)}
            >
              {grn.ap_bills.source_ref} — {grn.ap_bills.amount.toLocaleString("id-ID")}
            </button>
          ),
        },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Item Diterima", badge: grn.goods_receipt_lines.length },
    { key: "jurnal", label: "Jurnal", badge: journalEntries.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/goods-receipts" label="Kembali ke Goods Receipts" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Goods Receipt Details</h1>
          <span
            className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600"
            title="GRN gak punya nomor dokumen sendiri -- ini nomor AP Bill yang dibuat bareng GRN ini"
          >
            {grn.ap_bills.source_ref}
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
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2 text-right">Qty Diterima</th>
                <th className="px-4 py-2 text-right">Harga/Unit</th>
              </tr>
            </thead>
            <tbody>
              {grn.goods_receipt_lines.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-black">
                    {l.items.name} ({l.items.uom})
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{l.qty_received}</td>
                  <td className="px-4 py-2 text-right font-mono">{l.unit_cost.toLocaleString("id-ID")}</td>
                </tr>
              ))}
              {grn.goods_receipt_lines.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                    Belum ada baris item.
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
