"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { closePeriodSchema, listPeriodClosings, nextPeriodStartDate, type PeriodClosing } from "@/lib/reports/period-closing";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { BackLink } from "@/components/ui/back-link";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function ClosePeriodPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [closings, setClosings] = useState<PeriodClosing[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [retainedEarningsAccountId, setRetainedEarningsAccountId] = useState("");
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
        .from("app_user_roles")
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
  const suggestedStart = nextPeriodStartDate(closings);

  async function handleClose(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = closePeriodSchema.safeParse({
      start_date: startDate,
      end_date: endDate,
      retained_earnings_account_id: retainedEarningsAccountId,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("period_closings");
    } catch (err) {
      setSubmitting(false);
      setFormError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("close_period", {
      p_start_date: parsed.data.start_date,
      p_end_date: parsed.data.end_date,
      p_retained_earnings_account_id: parsed.data.retained_earnings_account_id,
      p_source_ref: sourceRef,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    router.push("/reports/period-closing");
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/reports/period-closing" label="Kembali ke Tutup Buku" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tutup Periode Baru</h1>
        <p className="text-sm text-slate-500">
          Nol-in saldo Pendapatan/Beban untuk 1 rentang tanggal, pindahkan selisihnya ke Laba
          Ditahan, lalu kunci rentang itu dari transaksi baru.
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleClose} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
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
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Soal Tutup Buku
            </p>
            {suggestedStart && (
              <FormHint>
                Periode terakhir ditutup sampai {closings[closings.length - 1]?.end_date} — periode
                berikutnya wajib mulai {suggestedStart}.
              </FormHint>
            )}
            <p className="mt-2 text-sm text-slate-600">
              Saldo Pendapatan/Beban dihitung ulang langsung dari data jurnal saat ini. Setelah
              ditutup, rentang ini gak bisa dibuka lagi — koreksi cuma bisa lewat entry baru di
              periode berjalan.
            </p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menutup..." : "Tutup Periode"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Batal
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
