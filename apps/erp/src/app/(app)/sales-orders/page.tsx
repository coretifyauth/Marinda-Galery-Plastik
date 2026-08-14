"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Customer } from "@/lib/customers/schema";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createSalesOrderSchema, soStatus, type SalesOrder } from "@/lib/sales-orders/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { UomPriceQtyInput, type UomQtyChange } from "@/components/ui/uom-price-qty-input";

type LineInput = { item_id: string; qty_ordered: string; unit_price: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_ordered: "", unit_price: "" };
}

const statusStyle: Record<string, string> = {
  OPEN: "bg-slate-100 text-slate-600",
  PARTIALLY_FULFILLED: "bg-amber-50 text-amber-700",
  FULLY_FULFILLED: "bg-emerald-50 text-emerald-700",
  CANCELLED: "bg-slate-100 text-slate-400 line-through",
};

export default function SalesOrdersPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [soDate, setSoDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const loadOrders = useCallback(async () => {
    const { data, error } = await supabase
      .from("sales_orders")
      .select(
        "id, customer_id, so_date, expected_date, source_ref, created_at, cancelled_at, customers(name), sales_order_lines(id, item_id, qty_ordered, unit_price, items(name, uom), goods_issue_lines(qty_issued))"
      )
      .order("so_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setOrders((data ?? []) as unknown as SalesOrder[]);
  }, []);

  const loadCustomers = useCallback(async () => {
    const { data } = await supabase
      .from("customers")
      .select("id, name, contact, payment_term_days, archived_at")
      .order("name");
    setCustomers((data ?? []) as Customer[]);
  }, []);

  const loadItems = useCallback(async () => {
    const [{ data }, { data: units }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, archived_at")
        .order("name"),
      supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
    ]);
    setItems((data ?? []) as Item[]);
    setItemUnits((units ?? []) as ItemUnit[]);
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
      await Promise.all([loadCustomers(), loadItems(), loadOrders()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadItems, loadOrders]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function updateLineQty(index: number, change: UomQtyChange | null) {
    updateLine(index, {
      qty_ordered: change ? String(change.baseQty) : "",
      unit_price: change ? String(change.basePrice) : "",
    });
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

    const parsed = createSalesOrderSchema.safeParse({
      customer_id: customerId,
      so_date: soDate,
      expected_date: expectedDate || undefined,
      lines: lines.map((l) => ({
        item_id: l.item_id,
        qty_ordered: l.qty_ordered,
        unit_price: l.unit_price,
      })),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("sales_orders");
    } catch (err) {
      setSubmitting(false);
      setFormError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_sales_order", {
      p_customer_id: parsed.data.customer_id,
      p_so_date: parsed.data.so_date,
      p_expected_date: parsed.data.expected_date || null,
      p_source_ref: sourceRef,
      p_lines: parsed.data.lines,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setCustomerId("");
    setSoDate("");
    setExpectedDate("");
    setLines([emptyLine()]);
    setShowForm(false);
    await loadOrders();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  // Cuma barang yang punya minimal 1 item_units berharga yang bisa dipesan lewat form ini --
  // harga wajib otomatis dari item_units.price, gak ada lagi jalur input manual (lihat
  // memory/domain/inventory.md submodule "Satuan Jual & Harga").
  const sellableItems = items.filter((item) =>
    itemUnits.some((u) => u.item_id === item.id && u.price != null)
  );

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Sales Orders</h1>
        <p className="text-sm text-slate-500">
          Pesanan customer yang belum tentu bisa dikirim sekaligus — komitmen dulu, kirim
          belakangan (bisa dicicil). Buat penjualan langsung yang barangnya udah ready, pakai{" "}
          <span className="font-medium">Goods Issues</span> aja, gak perlu lewat sini.
        </p>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Sales Orders</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {orders.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadOrders()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm(true)}>
                + New
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Items</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((so) => (
              <tr
                key={so.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/sales-orders/${so.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">{so.customers.name}</td>
                <td className="whitespace-nowrap px-4 py-2">{so.so_date}</td>
                <td className="px-4 py-2">{so.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {so.sales_order_lines.map((l) => (
                      <li key={l.id}>
                        {l.items.name} — {l.qty_ordered} {l.items.uom} @ {l.unit_price.toLocaleString("id-ID")}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[soStatus(so)]}`}>
                    {soStatus(so)}
                  </span>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada sales order.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Buat Sales Order" maxWidth="max-w-3xl">
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <p className="mb-4 text-sm text-slate-500">
          Belum ada jurnal apa pun di titik ini — piutang & pendapatan baru diakui nanti pas
          barang beneran dikirim, lewat <span className="font-medium">Goods Issues</span>{" "}
          (halaman detail sales order ini).
        </p>
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customer">Customer</Label>
                <Select id="customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">Pilih customer...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="so_date">Tanggal Pesan</Label>
                <Input id="so_date" type="date" value={soDate} onChange={(e) => setSoDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expected_date">Butuh Tanggal</Label>
                <Input
                  id="expected_date"
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(14rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty & Satuan (harga otomatis)</span>
                <span />
              </div>
              {lines.map((line, i) => {
                const unitsForItem = itemUnits.filter((u) => u.item_id === line.item_id && u.price != null);
                return (
                  <div key={i} className="grid grid-cols-[1fr_minmax(14rem,auto)_2.5rem] gap-2">
                    <Select
                      value={line.item_id}
                      onChange={(e) => updateLine(i, { item_id: e.target.value, qty_ordered: "", unit_price: "" })}
                    >
                      <option value="">Pilih item...</option>
                      {sellableItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.uom})
                        </option>
                      ))}
                    </Select>
                    {line.item_id && unitsForItem.length > 0 ? (
                      <UomPriceQtyInput key={line.item_id} units={unitsForItem} onChange={(change) => updateLineQty(i, change)} />
                    ) : (
                      <span className="flex items-center text-xs text-slate-400">
                        {line.item_id ? "Barang ini belum punya harga jual" : "Pilih item dulu"}
                      </span>
                    )}
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
                );
              })}
              {sellableItems.length === 0 && (
                <p className="text-xs text-amber-600">
                  Belum ada barang dengan harga jual (item_units). Tambah satuan + harga di
                  halaman Items dulu.
                </p>
              )}
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah item
              </Button>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Menyimpan..." : "Simpan Sales Order"}
              </Button>
            </div>
        </form>
      </Modal>
    </div>
  );
}
