"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, usePosSales } from "@/lib/pos-sales/queries";
import type { PosSaleStatus } from "@/lib/pos-sales/schema";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Pagination } from "@/components/ui/pagination";

// Input kecil buat baris filter di header tabel -- Input/Select biasa terlalu besar buat
// muat di dalam <th>, jadi dibikin versi compact lokal (pola sama journal-entries/page.tsx).
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

type CustomerOption = { id: string; name: string };

export default function PosSalesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [statusFilter, setStatusFilter] = useState<PosSaleStatus | "">("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", lihat
  // journal-entries/page.tsx -- BUKAN useEffect, biar gak kena lint react-hooks/set-state-in-effect).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedRefSearch}|${customerId}|${statusFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    sourceRefSearch: debouncedRefSearch,
    customerId,
    status: statusFilter,
    page,
    pageSize,
  };
  const salesQuery = usePosSales(filters);
  const sales = salesQuery.data?.rows ?? [];
  const total = salesQuery.data?.total ?? 0;

  // customers: query terpisah, orthogonal ke pagination -- murah dan cuma jalan sekali (bukan
  // React Query, gak perlu ikut invalidate/refetch tabel pos_sales).
  const loadAux = useCallback(async () => {
    const { data: custData, error: custError } = await supabase
      .from("counterparties")
      .select("id, name, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "customer")
      .order("name");
    if (custError) {
      setLoadError(custError.message);
      return;
    }
    setLoadError(null);
    setCustomers((custData ?? []) as CustomerOption[]);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      if (!active) return;
      await loadAux();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAux]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">POS Sales</h1>
        <p className="text-sm text-slate-500">
          Riwayat penjualan tunai kios — transaksi dibuat lewat aplikasi kasir (apps/pos), bukan di sini.
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {salesQuery.error && <FormError>{(salesQuery.error as Error).message}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">POS Sales</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <Button variant="toolbar" onClick={() => salesQuery.refetch()}>
            Refresh
          </Button>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Pelanggan</th>
              <th className="px-4 py-2">Metode Bayar</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2">Status</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
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
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter customer"
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua Customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as PosSaleStatus | "")}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua status</option>
                  <option value="normal">Normal</option>
                  <option value="dibatalkan">Dibatalkan</option>
                </select>
              </th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr
                key={s.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/pos-sales/${s.id}`)}
              >
                <td className="whitespace-nowrap px-4 py-2">{s.sale_date}</td>
                <td className="px-4 py-2">{s.source_ref}</td>
                <td className="px-4 py-2">{s.customer_name ?? "Walk-in"}</td>
                <td className="px-4 py-2">{s.cash_account_name ?? "—"}</td>
                <td className="px-4 py-2 text-right font-mono">{s.total.toLocaleString("id-ID")}</td>
                <td className="px-4 py-2">
                  {s.status === "dibatalkan" ? (
                    <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">
                      Dibatalkan
                    </span>
                  ) : (
                    <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
                      Normal
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {sales.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  {salesQuery.isLoading ? "Memuat..." : "Belum ada transaksi POS."}
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
