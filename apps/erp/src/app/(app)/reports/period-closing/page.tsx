"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { listPeriodClosings, type PeriodClosing } from "@/lib/reports/period-closing";
import { BackLink } from "@/components/ui/back-link";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function PeriodClosingPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);
  const [closings, setClosings] = useState<PeriodClosing[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const closingRows = await listPeriodClosings();
      setLoadError(null);
      setClosings(closingRows);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Gagal memuat data");
    }
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      const { data: roleRows } = await supabase
        .from("user_roles")
        .select("role_name")
        .eq("user_id", session.user.id);
      if (!active) return;
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/reports" label="Kembali ke Laporan Keuangan" />
      <div>
        <h1 className="text-xl font-semibold text-black">Tutup Buku (Period Closing)</h1>
        <p className="text-sm text-slate-500">
          Nol-in saldo Pendapatan/Beban untuk 1 rentang tanggal, pindahkan selisihnya ke Laba
          Ditahan, lalu kunci rentang itu dari transaksi baru.
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      {canWrite && (
        <div className="flex justify-end">
          <Button variant="toolbar-primary" onClick={() => router.push("/reports/period-closing/close")}>
            + Tutup Periode Baru
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Riwayat Penutupan</span>
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {closings.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Dari</th>
              <th className="px-4 py-2">Sampai</th>
              <th className="px-4 py-2">Rujukan</th>
              <th className="px-4 py-2">Closing Entry</th>
              <th className="px-4 py-2">Ditutup Pada</th>
            </tr>
          </thead>
          <tbody>
            {closings.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada periode yang ditutup.
                </td>
              </tr>
            )}
            {closings.map((c) => (
              <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2 font-mono">{c.start_date}</td>
                <td className="whitespace-nowrap px-4 py-2 font-mono">{c.end_date}</td>
                <td className="px-4 py-2 text-black">{c.source_ref}</td>
                <td className="px-4 py-2 text-slate-500">
                  {c.journal_entry_id ? "Ada (nol-in Pendapatan/Beban)" : "Gak ada aktivitas"}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                  {new Date(c.created_at).toLocaleString("id-ID")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <FormHint>
        Saldo Pendapatan/Beban dihitung ulang langsung dari data jurnal saat ini — bukan dari
        laporan Income Statement yang mungkin sudah kamu lihat sebelumnya (bisa saja berubah
        kalau ada transaksi baru masuk sejak kamu terakhir lihat laporan). Setelah ditutup,
        rentang ini gak bisa dibuka lagi — koreksi cuma bisa lewat entry baru di periode
        berjalan.
      </FormHint>
    </div>
  );
}
