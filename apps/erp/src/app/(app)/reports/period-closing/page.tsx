"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { closePeriodSchema, listPeriodClosings, nextPeriodStartDate, type PeriodClosing } from "@/lib/reports/period-closing";
import { BackLink } from "@/components/ui/back-link";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";

export default function PeriodClosingPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [closings, setClosings] = useState<PeriodClosing[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [retainedEarningsAccountId, setRetainedEarningsAccountId] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);
  const equityAccounts = leafAccounts.filter((a) => a.category === "equity");

  const load = useCallback(async () => {
    try {
      const [{ data: accountRows, error: accErr }, closingRows] = await Promise.all([
        supabase
          .from("accounts")
          .select("id, code, name, category, normal_balance, is_contra, parent_id, archived_at")
          .order("code"),
        listPeriodClosings(),
      ]);
      if (accErr) {
        setLoadError(accErr.message);
        return;
      }
      setLoadError(null);
      setAccounts((accountRows ?? []) as Account[]);
      setClosings(closingRows);
      setStartDate((prev) => prev || nextPeriodStartDate(closingRows) || "");
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
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const suggestedStart = nextPeriodStartDate(closings);

  async function handleClose(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = closePeriodSchema.safeParse({
      start_date: startDate,
      end_date: endDate,
      retained_earnings_account_id: retainedEarningsAccountId,
      source_ref: sourceRef,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("close_period", {
      p_start_date: parsed.data.start_date,
      p_end_date: parsed.data.end_date,
      p_retained_earnings_account_id: parsed.data.retained_earnings_account_id,
      p_source_ref: parsed.data.source_ref,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setEndDate("");
    setSourceRef("");
    await load();
  }

  return (
    <div className="flex w-full max-w-3xl flex-1 flex-col gap-6">
      <BackLink href="/reports" label="Kembali ke Financial Reports" />
      <div>
        <h1 className="text-xl font-semibold text-black">Tutup Buku (Period Closing)</h1>
        <p className="text-sm text-slate-500">
          Nol-in saldo Pendapatan/Beban untuk 1 rentang tanggal, pindahkan selisihnya ke Laba
          Ditahan, lalu kunci rentang itu dari transaksi baru.
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      {canWrite && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-1 font-semibold text-black">Tutup Periode Baru</h2>
          {suggestedStart && (
            <FormHint>
              Periode terakhir ditutup sampai {closings[closings.length - 1]?.end_date} — periode
              berikutnya wajib mulai {suggestedStart}.
            </FormHint>
          )}
          <form onSubmit={handleClose} className="mt-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="start_date">Dari Tanggal</Label>
                <Input
                  id="start_date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="end_date">Sampai Tanggal</Label>
                <Input id="end_date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="re_account">Akun Laba Ditahan</Label>
                <Select
                  id="re_account"
                  value={retainedEarningsAccountId}
                  onChange={(e) => setRetainedEarningsAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {equityAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source_ref">Rujukan Dokumen</Label>
                <Input
                  id="source_ref"
                  placeholder="mis. TUTUP-BUKU-2026-08"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menutup..." : "Tutup Periode"}
            </Button>
          </form>
          <FormHint>
            Saldo Pendapatan/Beban dihitung ulang langsung dari data jurnal saat ini — bukan dari
            laporan Income Statement yang mungkin sudah kamu lihat sebelumnya (bisa saja berubah
            kalau ada transaksi baru masuk sejak kamu terakhir lihat laporan). Setelah ditutup,
            rentang ini gak bisa dibuka lagi — koreksi cuma bisa lewat entry baru di periode
            berjalan.
          </FormHint>
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
    </div>
  );
}
