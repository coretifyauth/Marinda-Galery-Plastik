"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Supplier } from "@/lib/suppliers/schema";
import type { Item } from "@/lib/items/schema";
import { createPurchaseOrderSchema, poStatus, type PurchaseOrder } from "@/lib/purchase-orders/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type LineInput = { item_id: string; qty_ordered: string; unit_cost_expected: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_ordered: "", unit_cost_expected: "" };
}

const statusStyle: Record<string, string> = {
  OPEN: "bg-slate-100 text-slate-600",
  PARTIALLY_RECEIVED: "bg-amber-50 text-amber-700",
  FULLY_RECEIVED: "bg-emerald-50 text-emerald-700",
};

export default function PurchaseOrdersPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [supplierId, setSupplierId] = useState("");
  const [poDate, setPoDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const rawMaterials = items.filter((i) => i.item_type === "RAW_MATERIAL");

  const loadOrders = useCallback(async () => {
    const { data, error } = await supabase
      .from("purchase_orders")
      .select(
        "id, supplier_id, po_date, expected_date, source_ref, created_at, suppliers(name), purchase_order_lines(id, item_id, qty_ordered, unit_cost_expected, items(name, uom), goods_receipt_lines(qty_received))"
      )
      .order("po_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setOrders((data ?? []) as unknown as PurchaseOrder[]);
  }, []);

  const loadSuppliers = useCallback(async () => {
    const { data } = await supabase
      .from("suppliers")
      .select("id, name, contact, payment_term_days, archived_at")
      .order("name");
    setSuppliers((data ?? []) as Supplier[]);
  }, []);

  const loadItems = useCallback(async () => {
    const { data } = await supabase
      .from("items")
      .select("id, name, item_type, uom, inventory_account_id, archived_at")
      .order("name");
    setItems((data ?? []) as Item[]);
  }, []);

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
      await Promise.all([loadSuppliers(), loadItems(), loadOrders()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadSuppliers, loadItems, loadOrders]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createPurchaseOrderSchema.safeParse({
      supplier_id: supplierId,
      po_date: poDate,
      expected_date: expectedDate || undefined,
      source_ref: sourceRef,
      lines: lines.map((l) => ({
        item_id: l.item_id,
        qty_ordered: l.qty_ordered,
        unit_cost_expected: l.unit_cost_expected,
      })),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_purchase_order", {
      p_supplier_id: parsed.data.supplier_id,
      p_po_date: parsed.data.po_date,
      p_expected_date: parsed.data.expected_date || null,
      p_source_ref: parsed.data.source_ref,
      p_lines: parsed.data.lines,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setSupplierId("");
    setPoDate("");
    setExpectedDate("");
    setSourceRef("");
    setLines([emptyLine()]);
    setShowForm(false);
    await loadOrders();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Purchase Orders — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Purchase Orders</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {orders.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadOrders()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm((v) => !v)}>
                + New
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Items</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => (
              <tr
                key={po.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/purchase-orders/${po.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">{po.suppliers.name}</td>
                <td className="whitespace-nowrap px-4 py-2">{po.po_date}</td>
                <td className="px-4 py-2">{po.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {po.purchase_order_lines.map((l) => (
                      <li key={l.id}>
                        {l.items.name} — {l.qty_ordered} {l.items.uom} @ {l.unit_cost_expected.toLocaleString("id-ID")}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[poStatus(po)]}`}>
                    {poStatus(po)}
                  </span>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada purchase order.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Buat Purchase Order</h2>
          {!canWrite && (
            <p className="mb-4 text-sm text-amber-600">
              Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
              ketolak RLS.
            </p>
          )}
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="supplier">Supplier</Label>
                <Select id="supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">Pilih supplier...</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="po_date">Tanggal PO</Label>
                <Input id="po_date" type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expected_date">Estimasi Tiba</Label>
                <Input
                  id="expected_date"
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source_ref">Rujukan dokumen (source_ref)</Label>
                <Input
                  id="source_ref"
                  placeholder="mis. PO-TEPUNG-003"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_6rem_8rem_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty Pesan</span>
                <span>Harga/Unit</span>
                <span />
              </div>
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-[1fr_6rem_8rem_2.5rem] gap-2">
                  <Select value={line.item_id} onChange={(e) => updateLine(i, { item_id: e.target.value })}>
                    <option value="">Pilih item...</option>
                    {rawMaterials.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.uom})
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={line.qty_ordered}
                    onChange={(e) => updateLine(i, { qty_ordered: e.target.value })}
                  />
                  <Input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={line.unit_cost_expected}
                    onChange={(e) => updateLine(i, { unit_cost_expected: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => removeLine(i)}
                    disabled={lines.length <= 1}
                    className="text-slate-400 hover:text-red-600 disabled:opacity-30"
                    aria-label="Hapus baris"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah item
              </Button>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan PO"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
