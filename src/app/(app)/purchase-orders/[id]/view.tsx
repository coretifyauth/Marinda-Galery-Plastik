"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { poStatus, type PurchaseOrder } from "@/lib/purchase-orders/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

type GrnRef = { id: string; receipt_date: string; delivery_note_ref: string | null };

const statusStyle: Record<string, string> = {
  OPEN: "bg-slate-100 text-slate-600",
  PARTIALLY_RECEIVED: "bg-amber-50 text-amber-700",
  FULLY_RECEIVED: "bg-emerald-50 text-emerald-700",
};

export function PurchaseOrderDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [grns, setGrns] = useState<GrnRef[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: poData, error: poErr } = await supabase
      .from("purchase_orders")
      .select(
        "id, supplier_id, po_date, expected_date, source_ref, created_at, suppliers(name), purchase_order_lines(id, item_id, qty_ordered, unit_cost_expected, items(name, uom), goods_receipt_lines(qty_received))"
      )
      .eq("id", id)
      .single();
    if (poErr || !poData) {
      setLoadError(poErr?.message ?? "Purchase order gak ditemukan.");
      return;
    }
    setPo(poData as unknown as PurchaseOrder);

    const { data: grnData } = await supabase
      .from("goods_receipt_notes")
      .select("id, receipt_date, delivery_note_ref")
      .eq("purchase_order_id", id)
      .order("receipt_date");
    setGrns((grnData ?? []) as GrnRef[]);
    setLoadError(null);
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

  if (!po) {
    return <FormError>{loadError ?? "Purchase order gak ditemukan."}</FormError>;
  }

  const status = poStatus(po);

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/purchase-orders" label="Kembali ke Purchase Orders" />
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-black">
              {po.suppliers.name} — {po.source_ref}
            </h1>
            <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[status]}`}>{status}</span>
          </div>
          <p className="text-sm text-slate-500">{po.po_date}</p>
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-slate-400">Tanggal PO</dt>
            <dd className="text-black">{po.po_date}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Estimasi Tiba</dt>
            <dd className="text-black">{po.expected_date ?? "-"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Rujukan Dokumen</dt>
            <dd className="text-black">{po.source_ref}</dd>
          </div>
        </dl>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Item Dipesan</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {po.purchase_order_lines.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2 text-right">Qty Pesan</th>
              <th className="px-4 py-2 text-right">Qty Diterima</th>
              <th className="px-4 py-2 text-right">Harga/Unit</th>
            </tr>
          </thead>
          <tbody>
            {po.purchase_order_lines.map((l) => {
              const received = l.goods_receipt_lines.reduce((sum, r) => sum + r.qty_received, 0);
              return (
                <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-black">
                    {l.items.name} ({l.items.uom})
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{l.qty_ordered}</td>
                  <td className="px-4 py-2 text-right font-mono">{received}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {l.unit_cost_expected.toLocaleString("id-ID")}
                  </td>
                </tr>
              );
            })}
            {po.purchase_order_lines.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada baris item.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Goods Receipts</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {grns.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal Terima</th>
              <th className="px-4 py-2">No. Surat Jalan</th>
            </tr>
          </thead>
          <tbody>
            {grns.map((g) => (
              <tr
                key={g.id}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                onClick={() => router.push(`/goods-receipts/${g.id}`)}
              >
                <td className="px-4 py-2 text-blue-600">{g.receipt_date}</td>
                <td className="px-4 py-2">{g.delivery_note_ref ?? "-"}</td>
              </tr>
            ))}
            {grns.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center text-slate-400">
                  Belum ada penerimaan barang.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
