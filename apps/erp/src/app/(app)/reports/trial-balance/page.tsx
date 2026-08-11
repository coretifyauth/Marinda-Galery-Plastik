"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getTrialBalance } from "@/lib/reports/trial-balance";
import { accountDepth } from "@/lib/reports/balances";
import type { TrialBalance } from "@/lib/reports/types";
import { BackLink } from "@/components/ui/back-link";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { FormError } from "@/components/ui/form-message";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function TrialBalancePage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [asOfDate, setAsOfDate] = useState(today());
  const [report, setReport] = useState<TrialBalance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getTrialBalance(date));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memuat laporan");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      if (!active) return;
      setCheckingSession(false);
      await load(asOfDate);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const isBalanced = report ? report.totalDebit === report.totalCredit : false;

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/reports" label="Kembali ke Financial Reports" />
      <div>
        <h1 className="text-xl font-semibold text-black">Trial Balance</h1>
        <p className="text-sm text-slate-500">
          Saldo semua akun sampai tanggal tertentu — fondasi Income Statement & Balance Sheet.
        </p>
      </div>

      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="as_of_date">Per Tanggal</Label>
          <Input
            id="as_of_date"
            type="date"
            value={asOfDate}
            onChange={(e) => {
              setAsOfDate(e.target.value);
              load(e.target.value);
            }}
          />
        </div>
      </div>

      {error && <FormError>{error}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Kode</th>
              <th className="px-4 py-2">Akun</th>
              <th className="px-4 py-2">Kategori</th>
              <th className="px-4 py-2 text-right">Debit</th>
              <th className="px-4 py-2 text-right">Kredit</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Memuat...
                </td>
              </tr>
            )}
            {!loading && report?.balances.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada transaksi sampai tanggal ini.
                </td>
              </tr>
            )}
            {!loading &&
              report?.rolledBalances
                .slice()
                .sort((a, b) => a.code.localeCompare(b.code))
                .map((b) => {
                  const isHeader = report.rolledBalances.some((c) => c.parent_id === b.id);
                  const depth = accountDepth(b, report.rolledBalances);
                  return (
                    <tr key={b.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2 font-mono">{b.code}</td>
                      <td
                        className={`px-4 py-2 text-black ${isHeader ? "font-semibold" : ""}`}
                        style={{ paddingLeft: `${1 + depth * 1.25}rem` }}
                      >
                        {b.name}
                        {b.is_contra && (
                          <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                            Kontra
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 capitalize text-slate-500">{b.category}</td>
                      <td className={`px-4 py-2 text-right font-mono ${isHeader ? "font-semibold" : ""}`}>
                        {b.normal_balance === "debit" ? b.balance.toLocaleString("id-ID") : ""}
                      </td>
                      <td className={`px-4 py-2 text-right font-mono ${isHeader ? "font-semibold" : ""}`}>
                        {b.normal_balance === "credit" ? b.balance.toLocaleString("id-ID") : ""}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
          {report && report.balances.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-medium text-black">
                <td className="px-4 py-2" colSpan={3}>
                  Total
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {report.totalDebit.toLocaleString("id-ID")}
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {report.totalCredit.toLocaleString("id-ID")}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {report && report.balances.length > 0 && (
        <p className={`text-sm ${isBalanced ? "text-emerald-600" : "text-red-600"}`}>
          {isBalanced
            ? "✓ Balance — total debit sama total kredit."
            : "✗ Gak balance — ada bug di modul lain, bukan toleransi pembulatan (lihat docs/domain/financial-reports.md)."}
        </p>
      )}
    </div>
  );
}
