"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { fetchWalkInCustomerId } from "@/lib/pos-settings/schema";
import type { Customer } from "@/lib/customers/schema";
import type { SoStatus } from "@/lib/sales-orders/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useSalesOrders } from "@/lib/sales-orders/queries";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Pagination } from "@/components/ui/pagination";
import { LoadingScreen, InlineSpinner } from "@/components/ui/loading-screen";

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

// Input kecil buat baris filter di header tabel -- Input/Select biasa terlalu besar buat
// muat di dalam <th>, jadi dibikin versi compact lokal daripada nambah varian ke komponen
// bersama (pola sama kayak journal-entries/page.tsx).
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function SalesOrdersPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<SoStatus | "">("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", bukan useEffect --
  // lihat journal-entries/page.tsx).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedRefSearch}|${customerFilter}|${statusFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    sourceRefSearch: debouncedRefSearch,
    customerId: customerFilter,
    status: statusFilter,
    page,
    pageSize,
  };
  const ordersQuery = useSalesOrders(filters);
  const orders = ordersQuery.data?.rows ?? [];
  const total = ordersQuery.data?.total ?? 0;

  const loadCustomers = useCallback(async () => {
    const walkInCustomerId = await fetchWalkInCustomerId();
    let query = supabase
      .from("counterparties")
      .select("id, name, contact, payment_term_days, archived_at, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "customer")
      .order("name");
    if (walkInCustomerId) query = query.neq("id", walkInCustomerId);
    const { data } = await query;
    setCustomers((data ?? []) as unknown as Customer[]);
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
      await loadCustomers();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Sales Order</h1>
        <p className="text-sm text-slate-500">
          Pesanan customer yang belum tentu bisa dikirim sekaligus — komitmen dulu, kirim
          belakangan (bisa dicicil). Buat penjualan langsung yang barangnya udah ready, pakai{" "}
          <span className="font-medium">Barang Keluar</span> aja, gak perlu lewat sini.
        </p>
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
            <span className="text-sm font-medium text-black">Sales Order</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => ordersQuery.refetch()}>
              Muat Ulang
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => router.push("/sales-orders/new")}>
                + Tambah
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Pelanggan</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Rujukan Dokumen</th>
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2">Status</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter pelanggan"
                  value={customerFilter}
                  onChange={(e) => setCustomerFilter(e.target.value)}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua pelanggan</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
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
                  onChange={(e) => setStatusFilter(e.target.value as SoStatus | "")}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua status</option>
                  <option value="OPEN">{statusLabel.OPEN}</option>
                  <option value="PARTIALLY_FULFILLED">{statusLabel.PARTIALLY_FULFILLED}</option>
                  <option value="FULLY_FULFILLED">{statusLabel.FULLY_FULFILLED}</option>
                  <option value="CANCELLED">{statusLabel.CANCELLED}</option>
                </select>
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((so) => (
              <tr
                key={so.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/sales-orders/${so.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">{so.counterparties.name}</td>
                <td className="whitespace-nowrap px-4 py-2">{so.order_date}</td>
                <td className="px-4 py-2">{so.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {so.order_lines.map((l) => (
                      <li key={l.id}>
                        {l.items.name} — {l.qty_ordered} {l.items.uom} @ {l.unit_price.toLocaleString("id-ID")}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[so.status]}`}>
                    {statusLabel[so.status] ?? so.status}
                  </span>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  {ordersQuery.isLoading ? <InlineSpinner /> : "Belum ada sales order."}
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
