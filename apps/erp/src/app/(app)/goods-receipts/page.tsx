"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useGoodsReceipts } from "@/lib/goods-receipts/queries";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Pagination } from "@/components/ui/pagination";
import { LoadingScreen, InlineSpinner } from "@/components/ui/loading-screen";

type PurchaseOrderOption = { id: string; source_ref: string };

// Input kecil buat baris filter di header tabel -- pola sama kayak journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function GoodsReceiptsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderOption[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [purchaseOrderFilter, setPurchaseOrderFilter] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", bukan useEffect --
  // lihat journal-entries/page.tsx).
  const filterKey = `${dateFrom}|${dateTo}|${purchaseOrderFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    purchaseOrderId: purchaseOrderFilter,
    page,
    pageSize,
  };
  const receiptsQuery = useGoodsReceipts(filters);
  const receipts = receiptsQuery.data?.rows ?? [];
  const total = receiptsQuery.data?.total ?? 0;

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
        .eq("direction", "PURCHASE")
        .order("order_date", { ascending: false });
      if (!active) return;
      setPurchaseOrders((data ?? []) as PurchaseOrderOption[]);
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
        <h1 className="text-xl font-semibold text-black">Barang Masuk</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {receiptsQuery.error && (
        <FormError>{(receiptsQuery.error as Error).message}</FormError>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Barang Masuk</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => receiptsQuery.refetch()}>
              Muat Ulang
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => router.push("/goods-receipts/new")}>
                + Tambah
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">PO</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Barang Diterima</th>
              <th className="px-4 py-2">Tagihan</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter purchase order"
                  value={purchaseOrderFilter}
                  onChange={(e) => setPurchaseOrderFilter(e.target.value)}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua PO</option>
                  {purchaseOrders.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.source_ref}
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
            </tr>
          </thead>
          <tbody>
            {receipts.map((grn) => (
              <tr
                key={grn.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/goods-receipts/${grn.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">
                  {grn.orders?.counterparties.name ?? grn.ap_bills.counterparties.name}
                </td>
                <td className="px-4 py-2">
                  {grn.orders ? (
                    grn.orders.source_ref
                  ) : (
                    <span className="text-slate-400">— (langsung)</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2">{grn.note_date}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {grn.goods_note_lines.map((l) => (
                      <li key={l.id}>
                        {l.items.name} — {l.qty} {l.items.uom} @ {l.unit_cost.toLocaleString("id-ID")}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2">{grn.ap_bills.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {grn.ap_bills.amount.toLocaleString("id-ID")}
                </td>
              </tr>
            ))}
            {receipts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  {receiptsQuery.isLoading ? <InlineSpinner /> : "Belum ada barang masuk."}
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
