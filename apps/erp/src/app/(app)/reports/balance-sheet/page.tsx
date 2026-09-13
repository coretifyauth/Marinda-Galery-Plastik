"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getBalanceSheet } from "@/lib/reports/balance-sheet";
import type { AccountBalance, BalanceSheet } from "@/lib/reports/types";
import { BackLink } from "@/components/ui/back-link";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { FormError, FormHint } from "@/components/ui/form-message";
import { LoadingScreen, InlineSpinner } from "@/components/ui/loading-screen";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function Section({ title, items }: { title: string; items: AccountBalance[] }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium uppercase text-slate-400">{title}</p>
      {items.length === 0 && <p className="text-slate-400">Tidak ada.</p>}
      {items.map((b) => (
        <div key={b.id} className="flex justify-between py-0.5">
          <span className="text-black">
            {b.code} — {b.name}
            {b.is_contra && (
              <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                Kontra
              </span>
            )}
          </span>
          <span className="font-mono">
            {b.is_contra ? `(${b.balance.toLocaleString("id-ID")})` : b.balance.toLocaleString("id-ID")}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function BalanceSheetPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [asOfDate, setAsOfDate] = useState(today());
  const [report, setReport] = useState<BalanceSheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getBalanceSheet(date));
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
    return <LoadingScreen />;
  }

  const isBalanced = report ? report.totalAssets === report.totalLiabilities + report.totalEquity : false;

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/reports" label="Kembali ke Laporan Keuangan" />
      <div>
        <h1 className="text-xl font-semibold text-black">Balance Sheet (Neraca)</h1>
        <p className="text-sm text-slate-500">Aset = Liabilitas + Ekuitas, per 1 tanggal tertentu.</p>
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

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {loading && <InlineSpinner />}
        {!loading && report && (
          <div className="grid grid-cols-1 gap-6 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-4">
              <Section title="Aset" items={report.assets} />
              <div className="flex justify-between border-t-2 border-slate-300 pt-2 font-semibold text-black">
                <span>Total Aset</span>
                <span className="font-mono">{report.totalAssets.toLocaleString("id-ID")}</span>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <Section title="Liabilitas" items={report.liabilities} />
              <div className="flex justify-between border-t border-slate-100 pt-1 font-medium text-black">
                <span>Total Liabilitas</span>
                <span className="font-mono">{report.totalLiabilities.toLocaleString("id-ID")}</span>
              </div>

              <Section title="Ekuitas" items={report.equity} />
              <div className="flex justify-between py-0.5">
                <span className="text-black">Laba Ditahan (dihitung ulang dari Income Statement)</span>
                <span className="font-mono">{report.retainedEarnings.toLocaleString("id-ID")}</span>
              </div>
              <div className="flex justify-between border-t border-slate-100 pt-1 font-medium text-black">
                <span>Total Ekuitas</span>
                <span className="font-mono">{report.totalEquity.toLocaleString("id-ID")}</span>
              </div>

              <div className="flex justify-between border-t-2 border-slate-300 pt-2 font-semibold text-black">
                <span>Total Liabilitas + Ekuitas</span>
                <span className="font-mono">
                  {(report.totalLiabilities + report.totalEquity).toLocaleString("id-ID")}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {report && (
        <p className={`text-sm ${isBalanced ? "text-emerald-600" : "text-red-600"}`}>
          {isBalanced
            ? "✓ Balance — Total Aset sama dengan Total Liabilitas + Ekuitas."
            : "✗ Gak balance — ada bug di query rollup, bukan toleransi pembulatan."}
        </p>
      )}

      <FormHint>
        Laba Ditahan di sini dihitung ulang tiap kali (kumulatif sejak transaksi pertama tercatat),
        bukan dibaca dari akun terpisah — Tutup Buku formal belum ada
        (`memory/scope-debt/period-closing.md`).
      </FormHint>
    </div>
  );
}
