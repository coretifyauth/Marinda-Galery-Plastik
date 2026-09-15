"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useJournalEntries } from "@/lib/journal-entries/queries";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Pagination } from "@/components/ui/pagination";
import { LoadingScreen, InlineSpinner } from "@/components/ui/loading-screen";

// Input kecil buat baris filter di header tabel -- Input/Select biasa terlalu besar buat
// muat di dalam <th>, jadi dibikin versi compact lokal daripada nambah varian ke komponen
// bersama (dipakai lagi kalau modul lain butuh pola sama).
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function JournalEntriesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [descSearchInput, setDescSearchInput] = useState("");
  const [refSearchInput, setRefSearchInput] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedDescSearch = useDebouncedValue(descSearchInput, 300);
  const debouncedRefSearch = useDebouncedValue(refSearchInput, 300);

  // Filter berubah -> balik ke halaman 1, biar gak kejebak di halaman kosong (mis. lagi di
  // halaman 3 terus filter dipersempit sampai cuma 1 halaman). Reset dilakukan pas render
  // (pola "adjust state during render" React), BUKAN di useEffect -- setState sinkron di
  // effect kena lint react-hooks/set-state-in-effect (cascading render).
  const filterKey = `${dateFrom}|${dateTo}|${debouncedDescSearch}|${debouncedRefSearch}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    dateFrom,
    dateTo,
    descriptionSearch: debouncedDescSearch,
    sourceRefSearch: debouncedRefSearch,
    page,
    pageSize,
  };
  const entriesQuery = useJournalEntries(filters);
  const entries = entriesQuery.data?.rows ?? [];
  const total = entriesQuery.data?.total ?? 0;

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
        <h1 className="text-xl font-semibold text-black">Jurnal Umum</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {entriesQuery.error && (
        <FormError>{(entriesQuery.error as Error).message}</FormError>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Jurnal Umum</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => router.push("/journal-entries/presets")}>
              Kelola Preset
            </Button>
            <Button variant="toolbar" onClick={() => entriesQuery.refetch()}>
              Muat Ulang
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => router.push("/journal-entries/new")}>
                + Tambah
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="w-8 px-4 py-2" />
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Deskripsi</th>
              <th className="px-4 py-2">Rujukan Dokumen</th>
              <th className="px-4 py-2">Baris</th>
              <th className="px-4 py-2 text-right">Total</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
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
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari deskripsi..."
                  value={descSearchInput}
                  onChange={(e) => setDescSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
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
              <th className="px-4 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const total = entry.journal_lines.reduce((sum, l) => sum + l.debit, 0);
              return (
                <tr
                  key={entry.id}
                  className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                  onClick={() => router.push(`/journal-entries/${entry.id}`)}
                >
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="rounded border-slate-300" />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{entry.entry_date}</td>
                  <td className="px-4 py-2">
                    {entry.description}
                    {entry.reverses_entry_id && (
                      <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                        Pembalikan
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{entry.source_ref}</td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5">
                      {entry.journal_lines.map((line) => (
                        <li key={line.id}>
                          {line.accounts.code} {line.accounts.name} —{" "}
                          {line.debit > 0
                            ? `D ${line.debit.toLocaleString("id-ID")}`
                            : `K ${line.credit.toLocaleString("id-ID")}`}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {total.toLocaleString("id-ID")}
                  </td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  {entriesQuery.isLoading ? <InlineSpinner /> : "Belum ada jurnal."}
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
