"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { returnCreditRemaining, refundArReturnCreditSchema, type ArReturnCredit } from "@/lib/ar-return-credits/schema";
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

export default function RefundArReturnCreditPage() {
  const { id, creditId } = useParams<{ id: string; creditId: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [credit, setCredit] = useState<ArReturnCredit | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [refundCreditAmount, setRefundCreditAmount] = useState("");
  const [refundCreditDate, setRefundCreditDate] = useState("");
  const [refundCreditMethod, setRefundCreditMethod] = useState<CashMethod>("TUNAI");
  const [refundCreditError, setRefundCreditError] = useState<string | null>(null);
  const [refundCreditSubmitting, setRefundCreditSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [defAccs, { data: rc, error: rcErr }] = await Promise.all([
      fetchDefaultAccounts(),
      supabase
        .from("return_credits")
        .select(
          "id, customer_id:counterparty_id, return_id, amount, journal_entry_id, created_at, counterparties(name), ar_returns:returns(source_ref, credit_note_date), ar_return_credit_refunds:return_credit_refunds(id, amount, source_ref, journal_entry_id, created_at)"
        )
        .eq("id", creditId)
        .eq("type", "INBOUND")
        .single(),
    ]);
    setDefaultAccounts(defAccs);
    if (rcErr || !rc) {
      setLoadError(rcErr?.message ?? "Saldo kredit retur gak ditemukan.");
      return;
    }
    setCredit(rc as unknown as ArReturnCredit);
    setLoadError(null);
  }, [creditId]);

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

  async function handleRefundCreditSubmit(e: FormEvent) {
    e.preventDefault();
    setRefundCreditError(null);

    const parsed = refundArReturnCreditSchema.safeParse({
      credit_id: creditId,
      amount: refundCreditAmount,
      entry_date: refundCreditDate,
      return_credit_liability_account_id: defaultAccounts["ar.return_credit_liability"]?.id ?? "",
      cash_account_id: resolveCashAccount(refundCreditMethod, defaultAccounts)?.id ?? "",
    });
    if (!parsed.success) {
      setRefundCreditError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setRefundCreditSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ar_return_credit_refunds");
    } catch (err) {
      setRefundCreditSubmitting(false);
      setRefundCreditError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("refund_return_credit", {
      p_credit_id: parsed.data.credit_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: sourceRef,
      p_return_credit_account_id: parsed.data.return_credit_liability_account_id,
      p_cash_account_id: parsed.data.cash_account_id,
    });
    setRefundCreditSubmitting(false);
    if (error) {
      setRefundCreditError(error.message);
      return;
    }

    router.push(`/ar-invoices/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!credit) {
    return <FormError>{loadError ?? "Saldo kredit retur gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const { remaining } = returnCreditRemaining(credit);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ar-invoices/${id}`} label="Kembali ke Detail Invoice" />

      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-black">Refund Tunai Saldo Kredit Retur</h1>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
          {credit.ar_returns.source_ref}
        </span>
      </div>
      <p className="-mt-4 text-sm text-slate-500">
        Kembalikan sisa saldo kredit retur ini ke customer dalam bentuk kas/bank. Sisa saldo saat
        ini: Rp{remaining.toLocaleString("id-ID")}.
      </p>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleRefundCreditSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_credit_amount">Nominal Refund</Label>
                <Input
                  id="refund_credit_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={refundCreditAmount}
                  onChange={(e) => setRefundCreditAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_credit_date">Tanggal</Label>
                <Input
                  id="refund_credit_date"
                  type="date"
                  value={refundCreditDate}
                  onChange={(e) => setRefundCreditDate(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Saldo Kredit Retur Pelanggan (debit)"
                htmlFor="refund_credit_liability_account"
                resolved={defaultAccounts["ar.return_credit_liability"]}
              />
              <CashMethodField
                label="Akun Kas/Bank (kredit)"
                htmlFor="refund_credit_cash_account"
                method={refundCreditMethod}
                onChange={setRefundCreditMethod}
                defaultAccounts={defaultAccounts}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                {
                  label: "Akun Saldo Kredit Retur Pelanggan (debit)",
                  resolved: defaultAccounts["ar.return_credit_liability"],
                  side: "debit",
                },
                {
                  label: "Akun Kas/Bank (kredit)",
                  resolved: resolveCashAccount(refundCreditMethod, defaultAccounts),
                  side: "credit",
                },
              ],
            ]}
          />

          {refundCreditError && <FormError>{refundCreditError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={refundCreditSubmitting}>
              {refundCreditSubmitting ? "Menyimpan..." : "Refund"}
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
