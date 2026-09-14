"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { BomHeader } from "@/lib/bom/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useProductionOrders } from "@/lib/production-orders/queries";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Pagination } from "@/components/ui/pagination";
import { LoadingScreen, InlineSpinner } from "@/components/ui/loading-screen";

// Input kecil buat baris filter di header tabel -- pola sama kayak journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function ProductionOrdersPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [boms, setBoms] = useState<BomHeader[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [bomFilter, setBomFilter] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

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
      await loadBoms();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadBoms]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Production Order</h1>
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
            <span className="text-sm font-medium text-black">Production Order</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => ordersQuery.refetch()}>
              Muat Ulang
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => router.push("/production-orders/new")}>
                + Tambah
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Rujukan Dokumen</th>
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
                  {ordersQuery.isLoading ? <InlineSpinner /> : "Belum ada production order."}
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
    </div>
  );
}
