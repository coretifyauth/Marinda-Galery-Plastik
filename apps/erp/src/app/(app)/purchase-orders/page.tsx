"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Supplier } from "@/lib/suppliers/schema";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createPurchaseOrderSchema, type PoStatus, type CreatePurchaseOrderInput } from "@/lib/purchase-orders/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, usePurchaseOrders } from "@/lib/purchase-orders/queries";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { UnitCostQtyInput, type UnitCostQtyChange } from "@/components/ui/unit-cost-qty-input";

type LineInput = { item_id: string; qty_ordered: string; unit_cost_expected: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_ordered: "", unit_cost_expected: "" };
}

const statusStyle: Record<string, string> = {
  OPEN: "bg-slate-100 text-slate-600",
  PARTIALLY_RECEIVED: "bg-amber-50 text-amber-700",
  FULLY_RECEIVED: "bg-emerald-50 text-emerald-700",
  CANCELLED: "bg-slate-100 text-slate-400 line-through",
};

// Input kecil buat baris filter di header tabel -- pola sama kayak journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function PurchaseOrdersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<PoStatus | "">("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  const [supplierId, setSupplierId] = useState("");
  const [poDate, setPoDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", bukan useEffect --
  // lihat journal-entries/page.tsx).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedRefSearch}|${supplierFilter}|${statusFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    sourceRefSearch: debouncedRefSearch,
    supplierId: supplierFilter,
    status: statusFilter,
    page,
    pageSize,
  };
  const ordersQuery = usePurchaseOrders(filters);
  const orders = ordersQuery.data?.rows ?? [];
  const total = ordersQuery.data?.total ?? 0;

  const loadSuppliers = useCallback(async () => {
    const { data } = await supabase
      .from("counterparties")
      .select("id, name, contact, payment_term_days, archived_at, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "supplier")
      .order("name");
    setSuppliers((data ?? []) as Supplier[]);
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
      await Promise.all([loadSuppliers(), loadItems()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadSuppliers, loadItems]);

  const createMutation = useMutation({
    mutationFn: async (input: CreatePurchaseOrderInput) => {
      const sourceRef = await generateDocumentNumber("purchase_orders");
      const { error } = await supabase.rpc("create_order", {
        p_direction: "PURCHASE",
        p_counterparty_id: input.supplier_id,
        p_order_date: input.po_date,
        p_expected_date: input.expected_date || null,
        p_source_ref: sourceRef,
        p_lines: input.lines,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setSupplierId("");
      setPoDate("");
      setExpectedDate("");
      setLines([emptyLine()]);
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["purchase_orders"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan purchase order");
    },
  });

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function updateLineQtyCost(index: number, change: UnitCostQtyChange | null) {
    updateLine(index, {
      qty_ordered: change ? String(change.baseQty) : "",
      unit_cost_expected: change ? String(change.baseCost) : "",
    });
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createPurchaseOrderSchema.safeParse({
      supplier_id: supplierId,
      po_date: poDate,
      expected_date: expectedDate || undefined,
      lines: lines.map((l) => ({
        item_id: l.item_id,
        qty_ordered: l.qty_ordered,
        unit_price: l.unit_cost_expected,
      })),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    createMutation.mutate(parsed.data);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Purchase Orders</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {ordersQuery.error && (
        <FormError>{(ordersQuery.error as Error).message}</FormError>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Purchase Orders</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => ordersQuery.refetch()}>
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
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Items</th>
              <th className="px-4 py-2">Status</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter supplier"
                  value={supplierFilter}
                  onChange={(e) => setSupplierFilter(e.target.value)}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua supplier</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-4 py-1.5">
                <div className="flex gap-1">
                  <input
                    type="date"
                    aria-label="Dari tanggal"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className={compactFilterInputClass}
                  />
                  <input
                    type="date"
                    aria-label="Sampai tanggal"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className={compactFilterInputClass}
                  />
                </div>
              </th>
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari source ref..."
                  value={refSearchInput}
                  onChange={(e) => setRefSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as PoStatus | "")}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua status</option>
                  <option value="OPEN">Open</option>
                  <option value="PARTIALLY_RECEIVED">Partially Received</option>
                  <option value="FULLY_RECEIVED">Fully Received</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => (
              <tr
                key={po.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/purchase-orders/${po.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">{po.counterparties.name}</td>
                <td className="whitespace-nowrap px-4 py-2">{po.order_date}</td>
                <td className="px-4 py-2">{po.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {po.order_lines.map((l) => (
                      <li key={l.id}>
                        {l.items.name} — {l.qty_ordered} {l.items.uom} @ {l.unit_price.toLocaleString("id-ID")}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[po.status]}`}>
                    {po.status}
                  </span>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  {ordersQuery.isLoading ? "Memuat..." : "Belum ada purchase order."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageSizeChange={setPageSize}
        />
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Buat Purchase Order" maxWidth="max-w-3xl">
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
            </div>

            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty, Satuan & Harga Beli</span>
                <span />
              </div>
              {lines.map((line, i) => {
                const selectedItem = items.find((it) => it.id === line.item_id);
                const unitsForItem = itemUnits.filter((u) => u.item_id === line.item_id);
                return (
                  <div key={i} className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2">
                    <Select
                      value={line.item_id}
                      onChange={(e) =>
                        updateLine(i, { item_id: e.target.value, qty_ordered: "", unit_cost_expected: "" })
                      }
                    >
                      <option value="">Pilih item...</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.uom})
                        </option>
                      ))}
                    </Select>
                    {line.item_id ? (
                      <UnitCostQtyInput
                        key={line.item_id}
                        units={unitsForItem}
                        baseUom={selectedItem?.uom ?? ""}
                        onChange={(change) => updateLineQtyCost(i, change)}
                      />
                    ) : (
                      <span className="flex items-center text-xs text-slate-400">Pilih item dulu</span>
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
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah item
              </Button>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Menyimpan..." : "Simpan PO"}
              </Button>
            </div>
        </form>
      </Modal>
    </div>
  );
}
