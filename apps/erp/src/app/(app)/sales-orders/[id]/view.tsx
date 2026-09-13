"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { soStatus, type SalesOrder } from "@/lib/sales-orders/schema";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { LoadingScreen } from "@/components/ui/loading-screen";

type FulfillmentRow = {
  id: string;
  item_id: string;
  qty: number;
  total_cost: number;
  order_line_id: string | null;
  items: { name: string; uom: string };
  goods_notes: { id: string; transaction_id: string; note_date: string; ar_invoices: { source_ref: string; amount: number } };
};

const statusStyle: Record<string, string> = {
  OPEN: "bg-slate-100 text-slate-600",
  PARTIALLY_FULFILLED: "bg-amber-50 text-amber-700",
  FULLY_FULFILLED: "bg-emerald-50 text-emerald-700",
  CANCELLED: "bg-slate-100 text-slate-400 line-through",
};

const statusLabel: Record<string, string> = {
  OPEN: "Terbuka",
  PARTIALLY_FULFILLED: "Terpenuhi Sebagian",
  FULLY_FULFILLED: "Terpenuhi Penuh",
  CANCELLED: "Dibatalkan",
};

export function SalesOrderDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [so, setSo] = useState<SalesOrder | null>(null);
  const [fulfillments, setFulfillments] = useState<FulfillmentRow[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [activeTab, setActiveTab] = useState("lines");

  const load = useCallback(async () => {
    const { data: soData, error: soErr } = await supabase
      .from("orders")
      .select(
        "id, counterparty_id, order_date, expected_date, source_ref, created_at, cancelled_at, counterparties(name), order_lines(id, item_id, qty_ordered, unit_price, items(name, uom), goods_note_lines(qty))"
      )
      .eq("id", id)
      .eq("direction", "SALE")
      .single();
    if (soErr || !soData) {
      setLoadError(soErr?.message ?? "Sales order gak ditemukan.");
      return;
    }
    const typedSo = soData as unknown as SalesOrder;
    setSo(typedSo);

    const orderLineIds = typedSo.order_lines.map((l) => l.id);
    if (orderLineIds.length > 0) {
      const { data: fulfillData } = await supabase
        .from("goods_note_lines")
        .select(
          "id, item_id, qty, total_cost, order_line_id, items(name, uom), goods_notes(id, transaction_id, note_date, ar_invoices:transactions(source_ref, amount))"
        )
        .in("order_line_id", orderLineIds)
        .order("id");
      setFulfillments((fulfillData ?? []) as unknown as FulfillmentRow[]);
    }
    setLoadError(null);
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

  async function handleCancel() {
    if (!so) return;
    if (!window.confirm(`Batalkan sales order ${so.source_ref}?`)) return;

    setCancelError(null);
    setCancelling(true);
    const { error } = await supabase.rpc("cancel_order", {
      p_order_id: so.id,
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

  if (!so) {
    return <FormError>{loadError ?? "Sales order gak ditemukan."}</FormError>;
  }

  const status = soStatus(so);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canFulfill = canWrite && status !== "FULLY_FULFILLED" && status !== "CANCELLED";
  const canCancel = canWrite && status === "OPEN";

  const detailGroups = [
    {
      title: "Informasi Sales Order",
      rows: [
        { label: "Pelanggan", value: so.counterparties.name },
        { label: "Rujukan Dokumen", value: so.source_ref },
        { label: "Tanggal Pesan", value: so.order_date },
        { label: "Butuh Tanggal", value: so.expected_date ?? "-" },
        {
          label: "Status",
          value: <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[status]}`}>{statusLabel[status] ?? status}</span>,
        },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Item Dipesan", badge: so.order_lines.length },
    { key: "fulfillments", label: "Pengiriman (Barang Keluar + Invoice)", badge: fulfillments.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/sales-orders" label="Kembali ke Sales Order" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Detail Sales Order</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {so.source_ref}
          </span>
        </div>
        {canCancel && (
          <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? "Membatalkan..." : "Batalkan SO"}
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
                <th className="px-4 py-2 text-right">Qty Pesan</th>
                <th className="px-4 py-2 text-right">Qty Terkirim</th>
                <th className="px-4 py-2 text-right">Harga/Unit</th>
              </tr>
            </thead>
            <tbody>
              {so.order_lines.map((l) => {
                const issued = l.goods_note_lines.reduce((sum, r) => sum + r.qty, 0);
                return (
                  <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium text-black">
                      {l.items.name} ({l.items.uom})
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{l.qty_ordered}</td>
                    <td className="px-4 py-2 text-right font-mono">{issued}</td>
                    <td className="px-4 py-2 text-right font-mono">{l.unit_price.toLocaleString("id-ID")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "fulfillments" && (
        <div className="flex flex-col gap-3">
          {canFulfill && (
            <div className="flex justify-end">
              <Button variant="toolbar-primary" onClick={() => router.push(`/sales-orders/${id}/fulfill`)}>
                Kirim / Penuhi
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                  <th className="px-4 py-2">Tanggal</th>
                  <th className="px-4 py-2">Invoice</th>
                  <th className="px-4 py-2">Item</th>
                  <th className="px-4 py-2 text-right">Qty Dikirim</th>
                </tr>
              </thead>
              <tbody>
                {fulfillments.map((f) => (
                  <tr
                    key={f.id}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                    onClick={() => router.push(`/goods-issues/${f.goods_notes.id}`)}
                  >
                    <td className="px-4 py-2 text-blue-600">{f.goods_notes.note_date}</td>
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        className="text-blue-600 hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/ar-invoices/${f.goods_notes.transaction_id}`);
                        }}
                      >
                        {f.goods_notes.ar_invoices.source_ref}
                      </button>
                    </td>
                    <td className="px-4 py-2">
                      {f.items.name} ({f.items.uom})
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{f.qty}</td>
                  </tr>
                ))}
                {fulfillments.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                      Belum ada pengiriman.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
