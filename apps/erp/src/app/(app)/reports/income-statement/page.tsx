"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getIncomeStatement } from "@/lib/reports/income-statement";
import type { IncomeStatement } from "@/lib/reports/types";
import { BackLink } from "@/components/ui/back-link";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { FormError, FormHint } from "@/components/ui/form-message";

function firstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function IncomeStatementPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [startDate, setStartDate] = useState(firstOfMonth());
  const [endDate, setEndDate] = useState(today());
  const [report, setReport] = useState<IncomeStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (start: string, end: string) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getIncomeStatement(start, end));
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
      await load(startDate, endDate);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  function reload(start: string, end: string) {
    setStartDate(start);
    setEndDate(end);
    load(start, end);
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/reports" label="Kembali ke Financial Reports" />
      <div>
        <h1 className="text-xl font-semibold text-black">Income Statement (Laba Rugi)</h1>
        <p className="text-sm text-slate-500">Pendapatan dikurangi Beban untuk 1 rentang tanggal.</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="start_date">Dari Tanggal</Label>
          <Input
            id="start_date"
            type="date"
            value={startDate}
            onChange={(e) => reload(e.target.value, endDate)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="end_date">Sampai Tanggal</Label>
          <Input id="end_date" type="date" value={endDate} onChange={(e) => reload(startDate, e.target.value)} />
        </div>
      </div>

      {error && <FormError>{error}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {loading && <p className="text-sm text-slate-400">Memuat...</p>}
        {!loading && report && (
          <div className="flex flex-col gap-4 text-sm">
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase text-slate-400">Pendapatan</p>
              {report.revenues.length === 0 && <p className="text-slate-400">Tidak ada.</p>}
              {report.revenues.map((r) => (
                <div key={r.id} className="flex justify-between py-0.5">
                  <span className="text-black">
                    {r.code} — {r.name}
                  </span>
                  <span className="font-mono">{r.balance.toLocaleString("id-ID")}</span>
                </div>
              ))}
              <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 font-medium text-black">
                <span>Total Pendapatan</span>
                <span className="font-mono">{report.totalRevenue.toLocaleString("id-ID")}</span>
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase text-slate-400">Beban</p>
              {report.expenses.length === 0 && <p className="text-slate-400">Tidak ada.</p>}
              {report.expenses.map((r) => (
                <div key={r.id} className="flex justify-between py-0.5">
                  <span className="text-black">
                    {r.code} — {r.name}
                  </span>
                  <span className="font-mono">{r.balance.toLocaleString("id-ID")}</span>
                </div>
              ))}
              <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 font-medium text-black">
                <span>Total Beban</span>
                <span className="font-mono">{report.totalExpense.toLocaleString("id-ID")}</span>
              </div>
            </div>

            <div
              className={`flex justify-between border-t-2 border-slate-300 pt-2 text-base font-semibold ${
                report.netIncome >= 0 ? "text-emerald-700" : "text-red-700"
              }`}
            >
              <span>{report.netIncome >= 0 ? "Laba Bersih" : "Rugi Bersih"}</span>
              <span className="font-mono">{report.netIncome.toLocaleString("id-ID")}</span>
            </div>
          </div>
        )}
      </div>

      <FormHint>
        Belum ada Period Closing (`memory/scope-debt/period-closing.md`) — angka ini murni transaksi
        yang bertanggal di dalam rentang yang dipilih, bukan saldo yang sudah &quot;ditutup buku&quot; per periode.
      </FormHint>
    </div>
  );
}
