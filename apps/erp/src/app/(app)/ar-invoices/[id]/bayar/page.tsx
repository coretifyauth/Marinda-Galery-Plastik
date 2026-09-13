"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import { recordArPaymentSchema } from "@/lib/ar-payments/schema";
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

export default function RecordArPaymentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [invoice, setInvoice] = useState<ArInvoice | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [payDate, setPayDate] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<"TUNAI" | "BANK">("TUNAI");
  const [payError, setPayError] = useState<string | null>(null);
  const [paySubmitting, setPaySubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: inv, error: invErr } = await supabase
      .from("transactions")
      .select(
        "id, customer_id:counterparty_id, invoice_date:date, due_date, description, source_ref, amount, journal_entry_id, created_at, counterparties(name), ar_payments:payments(amount), ar_returns:returns(amount, ar_return_credits:return_credits(amount)), ar_deposit_applications:deposit_applications(amount)"
      )
      .eq("id", id)
      .eq("type", "OUTBOUND")
      .single();
    if (invErr || !inv) {
      setLoadError(invErr?.message ?? "Invoice gak ditemukan.");
      return;
    }
    setInvoice(inv as unknown as ArInvoice);

    const [defAccs, { data: reversedRows }] = await Promise.all([
      fetchDefaultAccounts(),
      supabase.from("journal_entries").select("reverses_entry_id").not("reverses_entry_id", "is", null),
    ]);
    setDefaultAccounts(defAccs);
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

  async function handlePaySubmit(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    setPayError(null);

    const parsed = recordArPaymentSchema.safeParse({
      customer_id: invoice.customer_id,
      payment_date: payDate,
      amount: payAmount,
      cash_account_id: resolveCashAccount(payMethod, defaultAccounts)?.id ?? "",
      receivable_account_id: defaultAccounts["ar.receivable"]?.id ?? "",
      invoice_id: invoice.id,
    });
    if (!parsed.success) {
      setPayError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setPaySubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ar_payments");
    } catch (err) {
      setPaySubmitting(false);
      setPayError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("record_payment", {
      p_type: "OUTBOUND",
      p_counterparty_id: parsed.data.customer_id,
      p_payment_date: parsed.data.payment_date,
      p_amount: parsed.data.amount,
      p_source_ref: sourceRef,
      p_cash_account_id: parsed.data.cash_account_id,
      p_control_account_id: parsed.data.receivable_account_id,
      p_transaction_id: parsed.data.invoice_id,
    });
    setPaySubmitting(false);
    if (error) {
      setPayError(error.message);
      return;
    }

    router.push(`/ar-invoices/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!invoice) {
    return <FormError>{loadError ?? "Invoice gak ditemukan."}</FormError>;
  }

  const isCancelled = reversedEntryIds.has(invoice.journal_entry_id);
  const { outstanding } = invoiceStatus(invoice, isCancelled);
  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ar-invoices/${id}`} label="Kembali ke Detail Invoice" />

      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-black">Catat Pembayaran</h1>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
          {invoice.source_ref}
        </span>
      </div>
      <p className="-mt-4 text-sm text-slate-500">
        Payment selalu nutup invoice ini spesifik, boleh cicil (kurang dari sisa outstanding),
        tapi gak boleh lebih (overpay ditolak).
      </p>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handlePaySubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pay_date">Tanggal</Label>
                <Input id="pay_date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pay_amount">
                  Jumlah dibayar (boleh cicil, maks {outstanding.toLocaleString("id-ID")})
                </Label>
                <Input
                  id="pay_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
              </div>
              <CashMethodField
                label="Akun Kas/Bank (debit)"
                htmlFor="pay_cash_account"
                method={payMethod}
                onChange={setPayMethod}
                defaultAccounts={defaultAccounts}
              />
              <LockedAccountField
                label="Akun Piutang Usaha (kredit)"
                htmlFor="pay_receivable_account"
                resolved={defaultAccounts["ar.receivable"]}
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
                  resolved: resolveCashAccount(payMethod, defaultAccounts),
                  side: "debit",
                },
                { label: "Akun Piutang Usaha (kredit)", resolved: defaultAccounts["ar.receivable"], side: "credit" },
              ],
            ]}
          />

          {payError && <FormError>{payError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={paySubmitting}>
              {paySubmitting ? "Menyimpan..." : "Simpan Pembayaran"}
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
