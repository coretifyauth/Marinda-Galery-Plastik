"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { itemTypes } from "@/lib/items/schema";
import type { ItemCategory } from "@/lib/item-categories/schema";
import type { ItemBrand } from "@/lib/item-brands/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useStockPosition } from "@/lib/inventory/queries";
import { formatStockBreakdown } from "@/lib/stock-display";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Pagination } from "@/components/ui/pagination";
import { LoadingScreen, InlineSpinner } from "@/components/ui/loading-screen";

const filterLabelClass = "flex flex-col gap-1 text-xs font-medium text-slate-500";
const filterControlClass =
  "w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-normal text-slate-800 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

const itemTypeLabel: Record<string, string> = {
  RAW_MATERIAL: "Bahan Baku",
  FINISHED_GOOD: "Barang Jadi",
};

export default function InventoryPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [brands, setBrands] = useState<ItemBrand[]>([]);

  const [nameSearchInput, setNameSearchInput] = useState("");
  const [itemTypeFilter, setItemTypeFilter] = useState<"" | (typeof itemTypes)[number]>("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [stockFilter, setStockFilter] = useState<"" | "ada">("ada");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedNameSearch = useDebouncedValue(nameSearchInput, 300);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render").
  const filterKey = `${debouncedNameSearch}|${itemTypeFilter}|${categoryFilter}|${brandFilter}|${stockFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const stockQuery = useStockPosition({
    nameSearch: debouncedNameSearch,
    itemType: itemTypeFilter,
    categoryId: categoryFilter,
    brandId: brandFilter,
    stock: stockFilter,
    page,
    pageSize,
  });
  const rows = stockQuery.data?.rows ?? [];
  const total = stockQuery.data?.total ?? 0;

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      const [catRes, brandRes] = await Promise.all([
        supabase.from("item_categories").select("id, name, archived_at").order("name"),
        supabase.from("item_brands").select("id, name, archived_at").order("name"),
      ]);
      if (!active) return;
      setCategories(((catRes.data ?? []) as ItemCategory[]).filter((c) => !c.archived_at));
      setBrands(((brandRes.data ?? []) as ItemBrand[]).filter((b) => !b.archived_at));
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const pageTotal = rows.reduce(
    (sum, r) => sum + (r.inventory_balances ? r.inventory_balances.qty_on_hand * r.inventory_balances.avg_cost : 0),
    0
  );

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Stock Position</h1>
        <p className="text-sm text-slate-500">
          Saldo akhir tiap item — Weighted Average rata-rata berjalan. Klik item buat lihat Kartu
          Stok (riwayat mutasi kronologis) di tab detail-nya. Item diarsipkan tidak ditampilkan.
        </p>
      </div>

      {stockQuery.error && <FormError>{(stockQuery.error as Error).message}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Stock Position</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{total}</span>
          </div>
          <Button variant="toolbar" onClick={() => stockQuery.refetch()}>
            Muat Ulang
          </Button>
        </div>
        <div className="grid gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className={filterLabelClass}>
            Nama barang
            <input
              type="text"
              placeholder="Cari nama barang..."
              value={nameSearchInput}
              onChange={(e) => setNameSearchInput(e.target.value)}
              className={filterControlClass}
            />
          </label>
          <label className={filterLabelClass}>
            Tipe
            <select
              value={itemTypeFilter}
              onChange={(e) => setItemTypeFilter(e.target.value as "" | (typeof itemTypes)[number])}
              className={filterControlClass}
            >
              <option value="">Semua tipe</option>
              {itemTypes.map((t) => (
                <option key={t} value={t}>
                  {itemTypeLabel[t] ?? t}
                </option>
              ))}
            </select>
          </label>
          <label className={filterLabelClass}>
            Kategori
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className={filterControlClass}
            >
              <option value="">Semua kategori</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={filterLabelClass}>
            Brand
            <select
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              className={filterControlClass}
            >
              <option value="">Semua brand</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className={filterLabelClass}>
            Stok
            <select
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value as "" | "ada")}
              className={filterControlClass}
            >
              <option value="ada">Hanya yang ada stok</option>
              <option value="">Semua (termasuk stok kosong)</option>
            </select>
          </label>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2">Avg Cost</th>
              <th className="px-4 py-2 text-right">Qty Tersisa</th>
              <th className="px-4 py-2 text-right">Nilai Persediaan</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const qty = item.inventory_balances?.qty_on_hand ?? 0;
              const avgCost = item.inventory_balances?.avg_cost ?? 0;
              return (
                <tr
                  key={item.id}
                  className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                  onClick={() => router.push(`/items/${item.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{item.name}</td>
                  <td className="px-4 py-2">
                    {avgCost.toLocaleString("id-ID")}/{item.uom}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {formatStockBreakdown(qty, item.uom, item.item_units)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{(qty * avgCost).toLocaleString("id-ID")}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  {stockQuery.isLoading ? <InlineSpinner /> : "Tidak ada item."}
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 font-medium text-black">
                <td colSpan={3} className="px-4 py-2 text-right">
                  Nilai Persediaan (halaman ini)
                </td>
                <td className="px-4 py-2 text-right font-mono">{pageTotal.toLocaleString("id-ID")}</td>
              </tr>
            </tfoot>
          )}
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
