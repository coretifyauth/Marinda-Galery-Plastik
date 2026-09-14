"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  depreciationMethods,
  accumulatedDepreciation,
  bookValue,
  type DepreciationEntry,
} from "@/lib/fixed-assets/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useFixedAssets } from "@/lib/fixed-assets/queries";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Pagination } from "@/components/ui/pagination";
import { LoadingScreen, InlineSpinner } from "@/components/ui/loading-screen";

// Input kecil buat baris filter di header tabel -- pola sama journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function FixedAssetsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [entries, setEntries] = useState<DepreciationEntry[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [nameSearchInput, setNameSearchInput] = useState("");
  const [methodFilter, setMethodFilter] = useState<"" | (typeof depreciationMethods)[number]>("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedNameSearch = useDebouncedValue(nameSearchInput, 300);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", lihat
  // journal-entries/page.tsx -- BUKAN useEffect, biar gak kena lint react-hooks/set-state-in-effect).
  const filterKey = `${debouncedNameSearch}|${methodFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    nameSearch: debouncedNameSearch,
    depreciationMethod: methodFilter,
    page,
    pageSize,
  };
  const assetsQuery = useFixedAssets(filters);
  const assets = assetsQuery.data?.rows ?? [];
  const total = assetsQuery.data?.total ?? 0;

  const loadEntries = useCallback(async () => {
    const { data } = await supabase
      .from("depreciation_entries")
      .select("id, fixed_asset_id, period, amount, journal_entry_id, created_at")
      .order("period");
    setEntries((data ?? []) as DepreciationEntry[]);
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
      await loadEntries();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadEntries]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Aset Tetap</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {assetsQuery.error && <FormError>{(assetsQuery.error as Error).message}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Aset Tetap</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => Promise.all([assetsQuery.refetch(), loadEntries()])}>
              Muat Ulang
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => router.push("/fixed-assets/new")}>
                + Tambah
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Nama</th>
              <th className="px-4 py-2">Metode</th>
              <th className="px-4 py-2 text-right">Nilai Perolehan</th>
              <th className="px-4 py-2 text-right">Akumulasi Penyusutan</th>
              <th className="px-4 py-2 text-right">Nilai Buku</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari nama..."
                  value={nameSearchInput}
                  onChange={(e) => setNameSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter metode"
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value as "" | (typeof depreciationMethods)[number])}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua Metode</option>
                  <option value="straight_line">Straight-Line</option>
                  <option value="declining_balance">Declining Balance</option>
                </select>
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => {
              const accumulated = accumulatedDepreciation(entries, asset.id);
              const book = bookValue(asset, accumulated);
              return (
                <tr
                  key={asset.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/fixed-assets/${asset.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{asset.name}</td>
                  <td className="px-4 py-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {asset.depreciation_method === "straight_line"
                        ? "Straight-Line"
                        : `Declining Balance (${(asset.depreciation_rate! * 100).toFixed(0)}%)`}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {asset.acquisition_cost.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {accumulated.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-medium text-black">
                    {book.toLocaleString("id-ID")}
                  </td>
                </tr>
              );
            })}
            {assets.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  {assetsQuery.isLoading ? <InlineSpinner /> : "Belum ada aset tetap."}
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
