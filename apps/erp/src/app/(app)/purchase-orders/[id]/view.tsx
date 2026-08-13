"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { poStatus, type PurchaseOrder } from "@/lib/purchase-orders/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Button } from "@/components/ui/button";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { escapeHtml, openPrintWindow } from "@/lib/print/print-window";

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
  const [activeTab, setActiveTab] = useState("lines");

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

  // Cetak selalu render dari state yang barusan di-`load()` -- gak ada snapshot tersimpan,
  // jadi cetak ulang kapan pun otomatis nunjukkan qty diterima terkini. Kop surat + blok tanda
  // tangan sengaja belum ada, lihat memory/scope-debt/print-template-letterhead-signature.md.
  function handlePrint() {
    if (!po) return;
    const lineRows = po.purchase_order_lines
      .map((l) => {
        const subtotal = l.qty_ordered * l.unit_cost_expected;
        return `<tr>
          <td>${escapeHtml(l.items.name)}</td>
          <td class="num">${l.qty_ordered} ${escapeHtml(l.items.uom)}</td>
          <td class="num">Rp${l.unit_cost_expected.toLocaleString("id-ID")}</td>
          <td class="num">Rp${subtotal.toLocaleString("id-ID")}</td>
        </tr>`;
      })
      .join("");
    const total = po.purchase_order_lines.reduce((sum, l) => sum + l.qty_ordered * l.unit_cost_expected, 0);

    const body = `
      <div style="margin-bottom:16px;">
        <h1>Purchase Order</h1>
        <div class="meta">${escapeHtml(po.source_ref)}</div>
      </div>
      <table>
        <tbody>
          <tr><td class="meta">Supplier</td><td>${escapeHtml(po.suppliers.name)}</td></tr>
          <tr><td class="meta">Tanggal PO</td><td>${escapeHtml(po.po_date)}</td></tr>
          <tr><td class="meta">Estimasi Tiba</td><td>${escapeHtml(po.expected_date ?? "-")}</td></tr>
        </tbody>
      </table>
      <table style="margin-top:20px;">
        <thead><tr><th>Barang</th><th class="num">Qty Pesan</th><th class="num">Harga/Unit</th><th class="num">Subtotal</th></tr></thead>
        <tbody>
          ${lineRows}
          <tr class="total-row"><td colspan="3">Total</td><td class="num">Rp${total.toLocaleString("id-ID")}</td></tr>
        </tbody>
      </table>
    `;

    if (!openPrintWindow(`PO ${po.source_ref}`, body)) {
      setLoadError("Popup diblokir browser — izinkan popup buat halaman ini, lalu coba lagi.");
    }
  }

  const detailGroups = [
    {
      title: "Informasi PO",
      rows: [
        { label: "Supplier", value: po.suppliers.name },
        { label: "Tanggal PO", value: po.po_date },
        { label: "Estimasi Tiba", value: po.expected_date ?? "-" },
        { label: "Rujukan Dokumen", value: po.source_ref },
        {
          label: "Status",
          value: <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[status]}`}>{status}</span>,
        },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Item Dipesan", badge: po.purchase_order_lines.length },
    { key: "grns", label: "Goods Receipts", badge: grns.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/purchase-orders" label="Kembali ke Purchase Orders" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Purchase Order Details</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {po.source_ref}
          </span>
        </div>
        <Button variant="toolbar" onClick={handlePrint}>
          Cetak
        </Button>
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
      )}

      {activeTab === "grns" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
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
      )}
    </div>
  );
}
