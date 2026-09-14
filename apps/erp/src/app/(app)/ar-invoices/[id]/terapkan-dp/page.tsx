"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import { applyArDepositSchema, depositStatus, type ArDeposit } from "@/lib/ar-deposits/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function ApplyArDepositToInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [invoice, setInvoice] = useState<ArInvoice | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [customerDeposits, setCustomerDeposits] = useState<ArDeposit[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [applyDepositId, setApplyDepositId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [applyDate, setApplyDate] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySubmitting, setApplySubmitting] = useState(false);

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
    const loadedInvoice = inv as unknown as ArInvoice;
    setInvoice(loadedInvoice);

    const [defAccs, { data: reversedRows }, { data: custDeposits, error: custDepositsErr }] = await Promise.all([
      fetchDefaultAccounts(),
      supabase.from("journal_entries").select("reverses_entry_id").not("reverses_entry_id", "is", null),
      supabase
        .from("deposits")
        .select(
          "id, customer_id:counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_at, counterparties(name), ar_deposit_applications:deposit_applications(id, amount, source_ref, journal_entry_id, ar_invoices:transactions(source_ref)), ar_deposit_refunds:deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ar_deposit_forfeitures:deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
        )
        .eq("counterparty_id", loadedInvoice.customer_id)
        .eq("type", "OUTBOUND")
        .order("deposit_date"),
    ]);

    setDefaultAccounts(defAccs);
    setReversedEntryIds(
      new Set(((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
    setCustomerDeposits((custDeposits ?? []) as unknown as ArDeposit[]);
    setLoadError(custDepositsErr?.message ?? null);
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

  async function handleApplySubmit(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    setApplyError(null);

    const parsed = applyArDepositSchema.safeParse({
      deposit_id: applyDepositId,
      invoice_id: invoice.id,
      amount: applyAmount,
      entry_date: applyDate,
      deposit_liability_account_id: defaultAccounts["ar.deposit_liability"]?.id ?? "",
      receivable_account_id: defaultAccounts["ar.receivable"]?.id ?? "",
    });
    if (!parsed.success) {
      setApplyError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setApplySubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ar_deposit_applications");
    } catch (err) {
      setApplySubmitting(false);
      setApplyError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("apply_deposit", {
      p_deposit_id: parsed.data.deposit_id,
      p_transaction_id: parsed.data.invoice_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: sourceRef,
      p_deposit_account_id: parsed.data.deposit_liability_account_id,
      p_control_account_id: parsed.data.receivable_account_id,
    });
    setApplySubmitting(false);
    if (error) {
      setApplyError(error.message);
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
  const availableDeposits = customerDeposits.filter(
    (dep) => depositStatus(dep, reversedEntryIds).remaining > 0.005
  );
  const selectedDeposit = availableDeposits.find((dep) => dep.id === applyDepositId) ?? null;
  const selectedDepositRemaining = selectedDeposit ? depositStatus(selectedDeposit, reversedEntryIds).remaining : 0;

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ar-invoices/${id}`} label="Kembali ke Detail Invoice" />

      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-black">Terapkan DP ke Invoice Ini</h1>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
          {invoice.source_ref}
        </span>
      </div>
      <p className="-mt-4 text-sm text-slate-500">
        Reklasifikasi uang muka yang udah diterima jadi pengurang piutang invoice ini — bukan
        pembayaran baru.
      </p>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleApplySubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_deposit">Uang Muka</Label>
                <Select
                  id="apply_deposit"
                  value={applyDepositId}
                  onChange={(e) => {
                    setApplyDepositId(e.target.value);
                    const dep = availableDeposits.find((d) => d.id === e.target.value);
                    if (dep) {
                      const remaining = depositStatus(dep, reversedEntryIds).remaining;
                      setApplyAmount(String(Math.min(remaining, outstanding)));
                    }
                  }}
                >
                  <option value="">Pilih deposit...</option>
                  {availableDeposits.map((dep) => {
                    const remaining = depositStatus(dep, reversedEntryIds).remaining;
                    return (
                      <option key={dep.id} value={dep.id}>
                        {dep.source_ref} (sisa {remaining.toLocaleString("id-ID")})
                      </option>
                    );
                  })}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_amount">
                  Nominal Diterapkan {selectedDeposit && `(maks ${Math.min(selectedDepositRemaining, outstanding).toLocaleString("id-ID")})`}
                </Label>
                <Input
                  id="apply_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={applyAmount}
                  onChange={(e) => setApplyAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_date">Tanggal</Label>
                <Input id="apply_date" type="date" value={applyDate} onChange={(e) => setApplyDate(e.target.value)} />
              </div>
              <LockedAccountField
                label="Akun Uang Muka Penjualan (debit)"
                htmlFor="apply_deposit_liability_account"
                resolved={defaultAccounts["ar.deposit_liability"]}
              />
              <LockedAccountField
                label="Akun Piutang Usaha (kredit)"
                htmlFor="apply_receivable_account"
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
                  label: "Akun Uang Muka Penjualan (debit)",
                  resolved: defaultAccounts["ar.deposit_liability"],
                  side: "debit",
                },
                { label: "Akun Piutang Usaha (kredit)", resolved: defaultAccounts["ar.receivable"], side: "credit" },
              ],
            ]}
          />

          {applyError && <FormError>{applyError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={applySubmitting}>
              {applySubmitting ? "Menyimpan..." : "Terapkan DP"}
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
