"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getCashFlow } from "@/lib/reports/cash-flow";
import type { CashFlow } from "@/lib/reports/types";
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

function Row({ label, value, indent }: { label: string; value: number; indent?: boolean }) {
  return (
    <div className={`flex justify-between py-0.5 ${indent ? "pl-4 text-slate-500" : "text-black"}`}>
      <span>{label}</span>
      <span className="font-mono">{value.toLocaleString("id-ID")}</span>
    </div>
  );
}

export default function CashFlowPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [startDate, setStartDate] = useState(firstOfMonth());
  const [endDate, setEndDate] = useState(today());
  const [report, setReport] = useState<CashFlow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (start: string, end: string) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getCashFlow(start, end));
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

  const reconciled = report ? report.beginningCash + report.netChange === report.endingCash : false;

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/reports" label="Kembali ke Financial Reports" />
      <div>
        <h1 className="text-xl font-semibold text-black">Cash Flow (Arus Kas) — Indirect Method</h1>
        <p className="text-sm text-slate-500">Pergerakan kas fisik untuk 1 rentang tanggal.</p>
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
          <div className="flex flex-col gap-5 text-sm">
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase text-slate-400">Operating</p>
              <Row label={report.netIncome >= 0 ? "Laba Bersih" : "Rugi Bersih"} value={report.netIncome} />
              <Row label="+ Beban Penyusutan (add-back)" value={report.depreciationAddBack} indent />
              {report.operatingWorkingCapital.map((line) => (
                <Row key={line.accountId} label={`Δ ${line.code} — ${line.name}`} value={line.contribution} indent />
              ))}
              <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 font-medium text-black">
                <span>Kas Bersih Operating</span>
                <span className="font-mono">{report.operating.toLocaleString("id-ID")}</span>
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase text-slate-400">Investing</p>
              <div className="flex justify-between font-medium text-black">
                <span>Kas Bersih Investing</span>
                <span className="font-mono">{report.investing.toLocaleString("id-ID")}</span>
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase text-slate-400">Financing</p>
              <div className="flex justify-between font-medium text-black">
                <span>Kas Bersih Financing</span>
                <span className="font-mono">{report.financing.toLocaleString("id-ID")}</span>
              </div>
            </div>

            <div className="flex justify-between border-t-2 border-slate-300 pt-2 text-base font-semibold text-black">
              <span>Kenaikan (Penurunan) Kas Bersih</span>
              <span className="font-mono">{report.netChange.toLocaleString("id-ID")}</span>
            </div>

            <div className="rounded-lg bg-slate-50 p-3">
              <Row label="Kas Awal" value={report.beginningCash} />
              <Row label="+ Kenaikan (Penurunan) Kas Bersih" value={report.netChange} indent />
              <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-medium text-black">
                <span>= Kas Akhir (hasil hitungan)</span>
                <span className="font-mono">
                  {(report.beginningCash + report.netChange).toLocaleString("id-ID")}
                </span>
              </div>
              <div className="mt-1 flex justify-between text-slate-500">
                <span>Saldo Kas di Trial Balance (fakta)</span>
                <span className="font-mono">{report.endingCash.toLocaleString("id-ID")}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {report && (
        <p className={`text-sm ${reconciled ? "text-emerald-600" : "text-red-600"}`}>
          {reconciled
            ? "✓ Match — Kas Akhir hasil hitungan sama dengan saldo Kas di Trial Balance."
            : "✗ Gak match — bug ada di logic Cash Flow, bukan di Trial Balance."}
        </p>
      )}

      <FormHint>
        Investing/Financing di sini diklasifikasikan dari akun lawan (Aset Tetap non-kontra = Investing,
        Ekuitas/Utang Bank = Financing) — mekanisme terbatas, belum generik. Detail:
        `memory/architecture/data/financial-reports-schema.md`.
      </FormHint>
    </div>
  );
}
