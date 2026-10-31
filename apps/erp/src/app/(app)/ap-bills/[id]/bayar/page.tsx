"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { billStatus, type ApBill } from "@/lib/ap-bills/schema";
import { recordApPaymentSchema } from "@/lib/ap-payments/schema";
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
import { DEFAULT_ROUNDING_UNITS, fetchRoundingUnits, previewPayment, type RoundingUnits } from "@/lib/payments/rounding";
import { PaymentPreviewNote, roundingLeg } from "@/components/ui/payment-preview-note";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function ApBillBayarPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [bill, setBill] = useState<ApBill | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [roundingUnits, setRoundingUnits] = useState<RoundingUnits>(DEFAULT_ROUNDING_UNITS);
  const [isCancelled, setIsCancelled] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [payDate, setPayDate] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payCashMethod, setPayCashMethod] = useState<CashMethod>("TUNAI");
  const [payError, setPayError] = useState<string | null>(null);
  const [paySubmitting, setPaySubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: b, error: billErr } = await supabase
      .from("transactions")
      .select(
        "id, supplier_id:counterparty_id, bill_date:date, due_date, description, source_ref, supplier_document_ref, amount, journal_entry_id, created_at, counterparties(name), ap_payments:payments(amount, payment_cancellations(payment_id)), ap_returns:returns(amount, ap_return_credits:return_credits(amount)), ap_deposit_applications:deposit_applications(amount), ap_bill_adjustments(amount)"
      )
      .eq("id", id)
      .eq("type", "INBOUND")
      .single();
    if (billErr || !b) {
      setLoadError(billErr?.message ?? "Bill gak ditemukan.");
      return;
    }
    const loadedBill = b as unknown as ApBill;
    setBill(loadedBill);

    const [defaultAccountsMap, units, { data: reversedRows }] = await Promise.all([
      fetchDefaultAccounts(),
      fetchRoundingUnits(),
      supabase
        .from("journal_entries")
        .select("reverses_entry_id")
        .not("reverses_entry_id", "is", null),
    ]);

    setDefaultAccounts(defaultAccountsMap);
    setRoundingUnits(units);
    const reversedIds = new Set(
      ((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id)
    );
    setIsCancelled(reversedIds.has(loadedBill.journal_entry_id));
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

  async function handlePaySubmit(e: FormEvent) {
    e.preventDefault();
    if (!bill) return;
    setPayError(null);

    const parsed = recordApPaymentSchema.safeParse({
      supplier_id: bill.supplier_id,
      payment_date: payDate,
      amount: payAmount,
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      payment_method: payCashMethod,
      bill_id: bill.id,
    });
    if (!parsed.success) {
      setPayError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    const payee = bill.supplier_document_ref ? `${bill.counterparties.name}, nota ${bill.supplier_document_ref}` : bill.counterparties.name;
    if (!window.confirm(`Catat pembayaran Rp${parsed.data.amount.toLocaleString("id-ID")} ke ${payee} (tagihan ${bill.source_ref}), tanggal ${parsed.data.payment_date}?`)) return;

    setPaySubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ap_payments");
    } catch (err) {
      setPaySubmitting(false);
      setPayError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("record_payment", {
      p_type: "INBOUND",
      p_counterparty_id: parsed.data.supplier_id,
      p_payment_date: parsed.data.payment_date,
      p_amount: parsed.data.amount,
      p_source_ref: sourceRef,
      p_payment_method: parsed.data.payment_method,
      p_control_account_id: parsed.data.payable_account_id,
      p_transaction_id: parsed.data.bill_id,
    });
    setPaySubmitting(false);
    if (error) {
      setPayError(error.message);
      return;
    }

    router.push(`/ap-bills/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!bill) {
    return <FormError>{loadError ?? "Bill gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const { outstanding } = billStatus(bill, isCancelled);
  const preview = previewPayment("INBOUND", outstanding, payAmount, roundingUnits[payCashMethod]);
  const blocked = preview.kind === "overpay" || preview.kind === "invalid";

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ap-bills/${id}`} label="Kembali ke Detail Tagihan" />

      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Catat Pembayaran</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {bill.source_ref}
          </span>
        </div>
        <p className="mt-1 text-sm font-medium text-black">
          {bill.counterparties.name}
          {bill.supplier_document_ref && <span className="font-normal text-slate-500"> · Nota {bill.supplier_document_ref}</span>}
        </p>
        <p className="text-sm text-slate-500">
          Payment selalu nutup bill ini spesifik, boleh cicil (kurang dari sisa outstanding), tapi gak boleh lebih
          (overpay ditolak). Isi uang yang benar-benar ditransfer/dibayar — kalau sisa tagihan ada pecahannya
          dan supplier menerima angka bulat, sistem otomatis mencatat lunas + selisih pembulatan.
        </p>
      </div>

      {isCancelled && <FormError>Bill ini sudah dibatalkan.</FormError>}
      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handlePaySubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pay_date">Tanggal</Label>
                <Input id="pay_date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pay_amount">
                  Uang yang dibayar (sisa tagihan {outstanding.toLocaleString("id-ID", { maximumFractionDigits: 2 })})
                </Label>
                <Input
                  id="pay_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
                <PaymentPreviewNote preview={preview} remaining={outstanding} unit={roundingUnits[payCashMethod]} />
              </div>
              <LockedAccountField
                label="Akun Utang Usaha (debit)"
                htmlFor="pay_payable_account"
                resolved={defaultAccounts["ap.payable"]}
              />
              <CashMethodField
                label="Akun Kas/Bank (kredit)"
                htmlFor="pay_cash_account"
                method={payCashMethod}
                onChange={setPayCashMethod}
                defaultAccounts={defaultAccounts}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                { label: "Akun Utang Usaha (debit)", resolved: defaultAccounts["ap.payable"], side: "debit" },
                {
                  label: "Akun Kas/Bank (kredit)",
                  resolved: resolveCashAccount(payCashMethod, defaultAccounts),
                  side: "credit",
                },
                roundingLeg(preview, defaultAccounts),
              ],
            ]}
          />

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">Jumlah Dibayar</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{(Number(payAmount) || 0).toLocaleString("id-ID")}</p>
          </div>

          {payError && <FormError>{payError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={paySubmitting || blocked}>
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
