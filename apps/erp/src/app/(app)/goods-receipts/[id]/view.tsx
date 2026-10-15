"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { GoodsReceiptNote } from "@/lib/goods-receipts/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Button } from "@/components/ui/button";
import { CancelledBadge, CancelledBanner } from "@/components/ui/cancelled";
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

export function GoodsReceiptDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [grn, setGrn] = useState<GoodsReceiptNote | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("lines");
  const [roles, setRoles] = useState<string[]>([]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    const { data: grnData, error: grnErr } = await supabase
      .from("goods_notes")
      .select(
        "id, order_id, transaction_id, delivery_note_ref, note_date, created_at, orders(source_ref, counterparties(name)), ap_bills:transactions(source_ref, amount, status, journal_entry_id, counterparties(name)), goods_note_lines(id, item_id, qty, unit_cost, items(name, uom))"
      )
      .eq("id", id)
      .eq("type", "INBOUND")
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

  // Barang masuk dan tagihannya dibuat 1 RPC, jadi dibatalkan juga lewat 1 RPC (cancel_ap_bill):
  // jurnal dibalik + stok dikurangi lagi + qty PO dibebaskan.
  async function handleCancel() {
    if (!grn) return;
    if (
      !window.confirm(
        `Batalkan barang masuk ${grn.ap_bills.source_ref}? Stok barang akan dikurangi lagi dan tagihan (Rp${grn.ap_bills.amount.toLocaleString("id-ID")}) ikut dibatalkan.`
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
    const { error } = await supabase.rpc("cancel_ap_bill", {
      p_bill_id: grn.transaction_id,
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

  if (!grn) {
    return <FormError>{loadError ?? "Goods receipt gak ditemukan."}</FormError>;
  }

  const isCancelled = grn.ap_bills.status === "dibatalkan";
  const canCancel = !isCancelled && (roles.includes("admin") || roles.includes("accountant"));

  const detailGroups = [
    {
      title: "Informasi Penerimaan",
      rows: [
        { label: "Tanggal Terima", value: grn.note_date },
        { label: "No. Surat Jalan", value: grn.delivery_note_ref ?? "-" },
        {
          label: "Purchase Order",
          value: grn.orders ? (
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => router.push(`/purchase-orders/${grn.order_id}`)}
            >
              {grn.orders.source_ref}
            </button>
          ) : (
            <span className="text-slate-400">— (langsung tanpa PO)</span>
          ),
        },
        {
          label: "Supplier",
          value: grn.orders?.counterparties.name ?? grn.ap_bills.counterparties.name,
        },
        {
          label: "Bill",
          value: (
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => router.push(`/ap-bills/${grn.transaction_id}`)}
            >
              {grn.ap_bills.source_ref} — {grn.ap_bills.amount.toLocaleString("id-ID")}
            </button>
          ),
        },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Item Diterima", badge: grn.goods_note_lines.length },
    { key: "jurnal", label: "Jurnal", badge: journalEntries.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/goods-receipts" label="Kembali ke Barang Masuk" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Barang Masuk</h1>
          <span
            className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600"
            title="GRN gak punya nomor dokumen sendiri -- ini nomor Tagihan yang dibuat bareng GRN ini"
          >
            {grn.ap_bills.source_ref}
          </span>
          {isCancelled && <CancelledBadge />}
        </div>
        {canCancel && (
          <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? "Membatalkan..." : "Batalkan Barang Masuk"}
          </Button>
        )}
      </div>

      {isCancelled && (
        <CancelledBanner>
          barang masuk ini tidak valid. Stok sudah dikurangi lagi dan tagihannya dibatalkan.
        </CancelledBanner>
      )}
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
                <th className="px-4 py-2 text-right">Qty Diterima</th>
                <th className="px-4 py-2 text-right">Harga/Unit</th>
              </tr>
            </thead>
            <tbody>
              {grn.goods_note_lines.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-black">
                    {l.items.name} ({l.items.uom})
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{l.qty}</td>
                  <td className="px-4 py-2 text-right font-mono">{l.unit_cost.toLocaleString("id-ID")}</td>
                </tr>
              ))}
              {grn.goods_note_lines.length === 0 && (
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
