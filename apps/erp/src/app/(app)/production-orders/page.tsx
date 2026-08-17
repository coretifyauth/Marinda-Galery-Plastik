"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { BomHeader } from "@/lib/bom/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createProductionOrderSchema, type CreateProductionOrderInput } from "@/lib/production-orders/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useProductionOrders } from "@/lib/production-orders/queries";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { MultiUomQtyInput } from "@/components/ui/multi-uom-qty-input";
import { Pagination } from "@/components/ui/pagination";

// Input kecil buat baris filter di header tabel -- pola sama kayak journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function ProductionOrdersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [boms, setBoms] = useState<BomHeader[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [bomFilter, setBomFilter] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  const [bomHeaderId, setBomHeaderId] = useState("");
  const [qtyProduced, setQtyProduced] = useState("");
  const [productionDate, setProductionDate] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const activeBoms = boms.filter((b) => b.is_active);
  const selectedBom = boms.find((b) => b.id === bomHeaderId);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", bukan useEffect --
  // lihat journal-entries/page.tsx).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedRefSearch}|${bomFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    sourceRefSearch: debouncedRefSearch,
    bomHeaderId: bomFilter,
    page,
    pageSize,
  };
  const ordersQuery = useProductionOrders(filters);
  const orders = ordersQuery.data?.rows ?? [];
  const total = ordersQuery.data?.total ?? 0;

  const loadBoms = useCallback(async () => {
    const { data } = await supabase
      .from("bom_headers")
      .select(
        "id, finished_item_id, output_qty, is_active, created_at, items(name, uom), bom_lines(id, raw_material_item_id, qty_per_batch, items(name, uom))"
      )
      .order("created_at", { ascending: false });
    setBoms((data ?? []) as unknown as BomHeader[]);
  }, []);

  const loadItemUnits = useCallback(async () => {
    const { data } = await supabase
      .from("item_units")
      .select("id, item_id, unit_label, conversion_factor, price, is_base");
    setItemUnits((data ?? []) as ItemUnit[]);
  }, []);

  const loadDefaultAccounts = useCallback(async () => {
    setDefaultAccounts(await fetchDefaultAccounts());
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
      await Promise.all([loadBoms(), loadItemUnits(), loadDefaultAccounts()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadBoms, loadItemUnits, loadDefaultAccounts]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateProductionOrderInput) => {
      const sourceRef = await generateDocumentNumber("production_orders");
      const { error } = await supabase.rpc("create_production_order", {
        p_bom_header_id: input.bom_header_id,
        p_qty_produced: input.qty_produced,
        p_production_date: input.production_date,
        p_source_ref: sourceRef,
        p_finished_good_debit_account_id: input.finished_good_debit_account_id,
        p_raw_material_credit_account_id: input.raw_material_credit_account_id,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setBomHeaderId("");
      setQtyProduced("");
      setProductionDate("");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["production_orders"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan production order");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createProductionOrderSchema.safeParse({
      bom_header_id: bomHeaderId,
      qty_produced: qtyProduced,
      production_date: productionDate,
      finished_good_debit_account_id: defaultAccounts["inventory.finished_good"]?.id ?? "",
      raw_material_credit_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
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
        <h1 className="text-xl font-semibold text-black">Production Orders</h1>
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
            <span className="text-sm font-medium text-black">Production Orders</span>
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
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Barang Jadi</th>
              <th className="px-4 py-2">Qty Produksi</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Konsumsi Bahan Baku</th>
              <th className="px-4 py-2 text-right">Total Biaya</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari source ref..."
                  value={refSearchInput}
                  onChange={(e) => setRefSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter resep (BOM)"
                  value={bomFilter}
                  onChange={(e) => setBomFilter(e.target.value)}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua barang jadi</option>
                  {boms.map((bom) => (
                    <option key={bom.id} value={bom.id}>
                      {bom.items.name}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-4 py-1.5" />
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
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => {
              const totalCost = po.production_order_lines.reduce((sum, l) => sum + l.total_cost, 0);
              return (
                <tr
                  key={po.id}
                  className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                  onClick={() => router.push(`/production-orders/${po.id}`)}
                >
                  <td className="px-4 py-2">{po.source_ref}</td>
                  <td className="px-4 py-2 font-medium text-black">{po.bom_headers.items.name}</td>
                  <td className="px-4 py-2">{po.qty_produced}</td>
                  <td className="whitespace-nowrap px-4 py-2">{po.production_date}</td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5">
                      {po.production_order_lines.map((l) => (
                        <li key={l.id}>
                          {l.items.name} — {l.qty_consumed} {l.items.uom} = {l.total_cost.toLocaleString("id-ID")}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{totalCost.toLocaleString("id-ID")}</td>
                </tr>
              );
            })}
            {orders.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  {ordersQuery.isLoading ? "Memuat..." : "Belum ada production order."}
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

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Jalankan Produksi" maxWidth="max-w-2xl">
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <p className="mb-4 text-sm text-slate-500">
          Bahan baku dikonsumsi otomatis sesuai resep (BOM), Weighted Average — gak perlu
          diinput manual di sini.
        </p>
        <JournalPreviewPanel
          groups={[
            [
              {
                label: "Akun Persediaan Barang Jadi (debit)",
                resolved: defaultAccounts["inventory.finished_good"],
                side: "debit",
              },
              {
                label: "Akun Persediaan Bahan Baku (kredit)",
                resolved: defaultAccounts["inventory.raw_material"],
                side: "credit",
              },
            ],
          ]}
        />
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bom">Resep (BOM)</Label>
                <Select
                  id="bom"
                  value={bomHeaderId}
                  onChange={(e) => {
                    setBomHeaderId(e.target.value);
                    setQtyProduced("");
                  }}
                >
                  <option value="">Pilih resep...</option>
                  {activeBoms.map((bom) => (
                    <option key={bom.id} value={bom.id}>
                      {bom.items.name} ({bom.output_qty} {bom.items.uom}/batch)
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="qty_produced">Qty Diproduksi per Satuan</Label>
                {selectedBom ? (
                  <MultiUomQtyInput
                    key={selectedBom.id}
                    units={itemUnits.filter((u) => u.item_id === selectedBom.finished_item_id)}
                    baseUom={selectedBom.items.uom}
                    onChange={(change) => setQtyProduced(change.baseQty)}
                  />
                ) : (
                  <span className="flex items-center text-xs text-slate-400">Pilih resep dulu</span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="production_date">Tanggal Produksi</Label>
                <Input
                  id="production_date"
                  type="date"
                  value={productionDate}
                  onChange={(e) => setProductionDate(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Persediaan Barang Jadi (debit)"
                htmlFor="finished_good_account"
                resolved={defaultAccounts["inventory.finished_good"]}
              />
              <LockedAccountField
                label="Akun Persediaan Bahan Baku (kredit)"
                htmlFor="raw_material_account"
                resolved={defaultAccounts["inventory.raw_material"]}
              />
            </div>

            {formError && <FormError>{formError}</FormError>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Memproses..." : "Jalankan Produksi"}
              </Button>
            </div>
        </form>
      </Modal>
    </div>
  );
}
