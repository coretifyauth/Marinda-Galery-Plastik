"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { refundApDepositSchema, depositStatus, type ApDeposit } from "@/lib/ap-deposits/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { CashMethodField, resolveCashAccount, type CashMethod } from "@/components/ui/cash-method-field";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function ApDepositRefundPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [deposit, setDeposit] = useState<ApDeposit | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [refundAmount, setRefundAmount] = useState("");
  const [refundDate, setRefundDate] = useState("");
  const [refundCashMethod, setRefundCashMethod] = useState<CashMethod>("TUNAI");
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: dep, error: depErr } = await supabase
      .from("deposits")
      .select(
        "id, supplier_id:counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_at, counterparties(name), ap_deposit_applications:deposit_applications(id, amount, source_ref, journal_entry_id, ap_bills:transactions(source_ref)), ap_deposit_refunds:deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ap_deposit_forfeitures:deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
      )
      .eq("id", id)
      .eq("type", "INBOUND")
      .single();
    if (depErr || !dep) {
      setLoadError(depErr?.message ?? "Deposit gak ditemukan.");
      return;
    }
    setDeposit(dep as unknown as ApDeposit);

    const [resolvedDefaultAccounts, { data: reversedRows }] = await Promise.all([
      fetchDefaultAccounts(),
      supabase
        .from("journal_entries")
        .select("reverses_entry_id")
        .not("reverses_entry_id", "is", null),
    ]);

    setDefaultAccounts(resolvedDefaultAccounts);
    setReversedEntryIds(
      new Set(((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
    setLoadError(null);
  }, [id]);

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

  async function handleRefundSubmit(e: FormEvent) {
    e.preventDefault();
    if (!deposit) return;
    setRefundError(null);

    const parsed = refundApDepositSchema.safeParse({
      deposit_id: deposit.id,
      amount: refundAmount,
      refund_date: refundDate,
      cash_account_id: resolveCashAccount(refundCashMethod, defaultAccounts)?.id ?? "",
      deposit_asset_account_id: defaultAccounts["ap.deposit_asset"]?.id ?? "",
    });
    if (!parsed.success) {
      setRefundError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setRefundSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ap_deposit_refunds");
    } catch (err) {
      setRefundSubmitting(false);
      setRefundError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("refund_deposit", {
      p_deposit_id: parsed.data.deposit_id,
      p_amount: parsed.data.amount,
      p_refund_date: parsed.data.refund_date,
      p_source_ref: sourceRef,
      p_cash_account_id: parsed.data.cash_account_id,
      p_deposit_account_id: parsed.data.deposit_asset_account_id,
    });
    setRefundSubmitting(false);
    if (error) {
      setRefundError(error.message);
      return;
    }

    router.push(`/ap-deposits/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!deposit) {
    return <FormError>{loadError ?? "Deposit gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const { remaining } = depositStatus(deposit, reversedEntryIds);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ap-deposits/${id}`} label="Kembali ke Detail Uang Muka AP" />

      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Refund Tunai Uang Muka</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {deposit.source_ref}
          </span>
        </div>
        <p className="text-sm text-slate-500">
          Terima kembali sisa deposit ini dari supplier dalam bentuk kas/bank — gak ada dampak Laba Rugi, murni
          reklasifikasi aset. Boleh sebagian.
        </p>
      </div>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleRefundSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_amount">Nominal Refund (maks {remaining.toLocaleString("id-ID")})</Label>
                <Input
                  id="refund_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_date">Tanggal</Label>
                <Input
                  id="refund_date"
                  type="date"
                  value={refundDate}
                  onChange={(e) => setRefundDate(e.target.value)}
                />
              </div>
              <CashMethodField
                label="Akun Kas/Bank (debit)"
                htmlFor="refund_cash_account"
                method={refundCashMethod}
                onChange={setRefundCashMethod}
                defaultAccounts={defaultAccounts}
              />
              <LockedAccountField
                label="Akun Uang Muka Pembelian (kredit)"
                htmlFor="refund_deposit_asset_account"
                resolved={defaultAccounts["ap.deposit_asset"]}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                {
                  label: "Akun Kas/Bank (debit)",
                  resolved: resolveCashAccount(refundCashMethod, defaultAccounts),
                  side: "debit",
                },
                {
                  label: "Akun Uang Muka Pembelian (kredit)",
                  resolved: defaultAccounts["ap.deposit_asset"],
                  side: "credit",
                },
              ],
            ]}
          />

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">Nominal Refund</p>
            <p className="mt-1 font-mono text-2xl text-black">
              Rp{(Number(refundAmount) || 0).toLocaleString("id-ID")}
            </p>
          </div>

          {refundError && <FormError>{refundError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={refundSubmitting}>
              {refundSubmitting ? "Menyimpan..." : "Refund"}
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
