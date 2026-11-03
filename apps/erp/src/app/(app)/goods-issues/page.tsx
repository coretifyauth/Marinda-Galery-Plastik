"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useChargeAccountIds, useGoodsIssues } from "@/lib/goods-issues/queries";
import { grossMargin, splitInvoiceLines } from "@/lib/goods-issues/margin";
import { useUserEmails } from "@/lib/user-emails/queries";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { IssueLinesTable } from "@/components/goods-issues/issue-lines-table";
import { Button } from "@/components/ui/button";
import { CancelledBadge, cancelledRowClass } from "@/components/ui/cancelled";
import { FormError } from "@/components/ui/form-message";
import { Pagination } from "@/components/ui/pagination";
import { LoadingScreen, InlineSpinner } from "@/components/ui/loading-screen";

// Input kecil buat baris filter di header tabel -- pola sama kayak journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

type SalesOrderOption = { id: string; source_ref: string };

export default function GoodsIssuesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [salesOrders, setSalesOrders] = useState<SalesOrderOption[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [salesOrderFilter, setSalesOrderFilter] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<"aktif" | "" | "dibatalkan">("aktif");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", bukan useEffect --
  // lihat journal-entries/page.tsx).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedRefSearch}|${salesOrderFilter}|${statusFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    sourceRefSearch: debouncedRefSearch,
    salesOrderId: salesOrderFilter,
    status: statusFilter,
    page,
    pageSize,
  };
  const issuesQuery = useGoodsIssues(filters);
  const issues = issuesQuery.data?.rows ?? [];
  const userEmails = useUserEmails(issues.map((gi) => gi.created_by)).data ?? {};
  const total = issuesQuery.data?.total ?? 0;
  const chargeAccountIds = useChargeAccountIds().data;

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
      const { data } = await supabase
        .from("orders")
        .select("id, source_ref")
        .eq("direction", "SALE")
        .order("order_date", { ascending: false });
      if (!active) return;
      setSalesOrders((data ?? []) as SalesOrderOption[]);
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Barang Keluar</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {issuesQuery.error && (
        <FormError>{(issuesQuery.error as Error).message}</FormError>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Barang Keluar</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => issuesQuery.refetch()}>
              Muat Ulang
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => router.push("/goods-issues/new")}>
                + Tambah
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Nomor</th>
              <th className="px-4 py-2">Pelanggan</th>
              <th className="px-4 py-2">SO</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Barang Keluar</th>
              <th className="px-4 py-2 text-right">Nilai Invoice</th>
              <th className="px-4 py-2 text-right">Total HPP</th>
              <th className="px-4 py-2 text-right">Laba Kotor (Margin)</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Invoice</th>
              <th className="px-4 py-2">Dibuat Oleh</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  aria-label="Cari nomor"
                  placeholder="Cari nomor..."
                  value={refSearchInput}
                  onChange={(e) => setRefSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter sales order"
                  value={salesOrderFilter}
                  onChange={(e) => setSalesOrderFilter(e.target.value)}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua SO</option>
                  {salesOrders.map((so) => (
                    <option key={so.id} value={so.id}>
                      {so.source_ref}
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
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as "aktif" | "" | "dibatalkan")}
                  className={compactFilterInputClass}
                >
                  <option value="aktif">Aktif (tanpa dibatalkan)</option>
                  <option value="">Semua status</option>
                  <option value="dibatalkan">Dibatalkan</option>
                </select>
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {issues.map((gi) => {
              const totalHpp = gi.goods_note_lines.reduce((sum, l) => sum + l.total_cost, 0);
              const cancelled = gi.ar_invoices.status === "dibatalkan";
              // Margin dari penjualan barang (net diskon, tanpa PPN & biaya tambahan) dikurangi HPP; belum dikurangi retur.
              const margin =
                !cancelled && chargeAccountIds
                  ? grossMargin(
                      splitInvoiceLines(gi.ar_invoices.transaction_lines ?? [], chargeAccountIds).goodsRevenue,
                      totalHpp
                    )
                  : null;
              return (
                <tr
                  key={gi.id}
                  className={`cursor-pointer border-b border-slate-100 align-top ${
                    cancelled ? cancelledRowClass : "hover:bg-slate-50"
                  }`}
                  onClick={() => router.push(`/goods-issues/${gi.id}`)}
                >
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-600">{gi.source_ref}</td>
                  <td className="px-4 py-2 font-medium text-black">{gi.ar_invoices.counterparties.name}</td>
                  <td className="px-4 py-2">
                    {gi.order?.source_ref ?? <span className="text-slate-400">— (langsung)</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{gi.note_date}</td>
                  <td className="px-4 py-2">
                    <IssueLinesTable lines={gi.goods_note_lines} />
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {gi.ar_invoices.amount.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{totalHpp.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {margin ? (
                      <div className={margin.profit < 0 ? "text-red-600" : "text-emerald-700"}>
                        {margin.profit.toLocaleString("id-ID")}
                        <div className="text-xs">
                          {margin.marginPct != null
                            ? `${margin.marginPct.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`
                            : "—"}
                        </div>
                      </div>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {cancelled ? (
                      <CancelledBadge />
                    ) : (
                      <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">Aktif</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-600">
                    <button
                      type="button"
                      className="text-blue-600 hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/ar-invoices/${gi.transaction_id}`);
                      }}
                    >
                      Lihat invoice
                    </button>
                  </td>
                  <td className="px-4 py-2 text-slate-500">{(gi.created_by && userEmails[gi.created_by]) ?? "-"}</td>
                </tr>
              );
            })}
            {issues.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-6 text-center text-slate-400">
                  {issuesQuery.isLoading ? <InlineSpinner /> : "Belum ada barang keluar."}
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
