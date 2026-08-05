"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import {
  applyArCustomerCreditSchema,
  refundArCustomerCreditSchema,
  customerCreditRemaining,
  type ArCustomerCredit,
} from "@/lib/ar-customer-credits/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  reverses_entry_id: string | null;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

export function ArCustomerCreditDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [credit, setCredit] = useState<ArCustomerCredit | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [customerInvoices, setCustomerInvoices] = useState<ArInvoice[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showApplyForm, setShowApplyForm] = useState(false);
  const [applyInvoiceId, setApplyInvoiceId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [applyDate, setApplyDate] = useState("");
  const [applySourceRef, setApplySourceRef] = useState("");
  const [applyCustomerCreditAccountId, setApplyCustomerCreditAccountId] = useState("");
  const [applyReceivableAccountId, setApplyReceivableAccountId] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySubmitting, setApplySubmitting] = useState(false);

  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundDate, setRefundDate] = useState("");
  const [refundSourceRef, setRefundSourceRef] = useState("");
  const [refundCustomerCreditAccountId, setRefundCustomerCreditAccountId] = useState("");
  const [refundCashAccountId, setRefundCashAccountId] = useState("");
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const { data: cred, error: credErr } = await supabase
      .from("ar_customer_credits")
      .select(
        "id, customer_id, payment_id, amount, journal_entry_id, created_at, customers(name), ar_payments(source_ref, payment_date), ar_customer_credit_applications(id, amount, source_ref, journal_entry_id, ar_invoices(source_ref)), ar_customer_credit_refunds(id, amount, source_ref, journal_entry_id, created_at)"
      )
      .eq("id", id)
      .single();
    if (credErr || !cred) {
      setLoadError(credErr?.message ?? "Saldo kredit gak ditemukan.");
      return;
    }
    const loadedCredit = cred as unknown as ArCustomerCredit;
    setCredit(loadedCredit);

    const [
      { data: accs },
      { data: reversedRows },
      { data: entries, error: entriesErr },
      { data: custInvoices, error: custInvoicesErr },
    ] = await Promise.all([
      supabase
        .from("accounts")
        .select("id, code, name, category, normal_balance, parent_id, archived_at")
        .order("code"),
      supabase
        .from("journal_entries")
        .select("reverses_entry_id")
        .not("reverses_entry_id", "is", null),
      supabase
        .from("journal_entries")
        .select(
          "id, entry_date, description, source_ref, reverses_entry_id, journal_lines(id, debit, credit, accounts(code, name))"
        )
        .or(`id.eq.${loadedCredit.journal_entry_id},reverses_entry_id.eq.${loadedCredit.journal_entry_id}`)
        .order("entry_date"),
      supabase
        .from("ar_invoices")
        .select(
          "id, customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_at, customers(name), ar_payment_allocations(amount), ar_credit_notes(amount), ar_deposit_applications(amount), ar_customer_credit_applications(amount)"
        )
        .eq("customer_id", loadedCredit.customer_id)
        .order("invoice_date"),
    ]);

    setAccounts((accs ?? []) as Account[]);
    setReversedEntryIds(
      new Set(((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setCustomerInvoices((custInvoices ?? []) as unknown as ArInvoice[]);
    setLoadError(entriesErr?.message ?? custInvoicesErr?.message ?? null);
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

  function openApplyForm() {
    setApplyError(null);
    setApplyInvoiceId("");
    setApplyAmount("");
    setApplyDate("");
    setApplySourceRef("");
    setApplyCustomerCreditAccountId("");
    setApplyReceivableAccountId("");
    setShowApplyForm(true);
  }

  async function handleApplySubmit(e: FormEvent) {
    e.preventDefault();
    if (!credit) return;
    setApplyError(null);

    const parsed = applyArCustomerCreditSchema.safeParse({
      credit_id: credit.id,
      invoice_id: applyInvoiceId,
      amount: applyAmount,
      entry_date: applyDate,
      source_ref: applySourceRef,
      customer_credit_account_id: applyCustomerCreditAccountId,
      receivable_account_id: applyReceivableAccountId,
    });
    if (!parsed.success) {
      setApplyError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setApplySubmitting(true);
    const { error } = await supabase.rpc("apply_ar_customer_credit", {
      p_credit_id: parsed.data.credit_id,
      p_invoice_id: parsed.data.invoice_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: parsed.data.source_ref,
      p_customer_credit_account_id: parsed.data.customer_credit_account_id,
      p_receivable_account_id: parsed.data.receivable_account_id,
    });
    setApplySubmitting(false);
    if (error) {
      setApplyError(error.message);
      return;
    }

    setShowApplyForm(false);
    await load();
  }

  function openRefundForm() {
    setRefundError(null);
    setRefundAmount("");
    setRefundDate("");
    setRefundSourceRef("");
    setRefundCustomerCreditAccountId("");
    setRefundCashAccountId("");
    setShowRefundForm(true);
  }

  async function handleRefundSubmit(e: FormEvent) {
    e.preventDefault();
    if (!credit) return;
    setRefundError(null);

    const parsed = refundArCustomerCreditSchema.safeParse({
      credit_id: credit.id,
      amount: refundAmount,
      entry_date: refundDate,
      source_ref: refundSourceRef,
      customer_credit_account_id: refundCustomerCreditAccountId,
      cash_account_id: refundCashAccountId,
    });
    if (!parsed.success) {
      setRefundError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setRefundSubmitting(true);
    const { error } = await supabase.rpc("refund_ar_customer_credit", {
      p_credit_id: parsed.data.credit_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: parsed.data.source_ref,
      p_customer_credit_account_id: parsed.data.customer_credit_account_id,
      p_cash_account_id: parsed.data.cash_account_id,
    });
    setRefundSubmitting(false);
    if (error) {
      setRefundError(error.message);
      return;
    }

    setShowRefundForm(false);
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!credit) {
    return <FormError>{loadError ?? "Saldo kredit gak ditemukan."}</FormError>;
  }

  const { used, remaining } = customerCreditRemaining(credit, reversedEntryIds);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canSpend = canWrite && remaining > 0.005;

  const outstandingInvoices = customerInvoices
    .map((inv) => ({
      invoice: inv,
      ...invoiceStatus(inv, reversedEntryIds.has(inv.journal_entry_id)),
    }))
    .filter((x) => x.status !== "lunas" && x.status !== "dibatalkan");

  const activeApplications = credit.ar_customer_credit_applications.filter(
    (a) => !reversedEntryIds.has(a.journal_entry_id)
  );
  const reversedApplications = credit.ar_customer_credit_applications.filter((a) =>
    reversedEntryIds.has(a.journal_entry_id)
  );

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/ar-customer-credits" label="Kembali ke AR Customer Credit" />
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-black">
            {credit.customers.name} — {credit.ar_payments.source_ref}
          </h1>
          <p className="text-sm text-slate-500">{credit.ar_payments.payment_date}</p>
        </div>
        <div className="flex items-start gap-4">
          <div className="text-right">
            <div className="text-xs uppercase text-slate-400">Sisa Saldo Kredit</div>
            <div className="font-mono text-lg font-medium text-black">{remaining.toLocaleString("id-ID")}</div>
          </div>
          {canSpend && (
            <div className="flex gap-1.5">
              <Button
                variant="toolbar"
                onClick={() => (showApplyForm ? setShowApplyForm(false) : openApplyForm())}
              >
                {showApplyForm ? "Batal Pakai" : "Pakai ke Invoice"}
              </Button>
              <Button
                variant="toolbar"
                onClick={() => (showRefundForm ? setShowRefundForm(false) : openRefundForm())}
              >
                {showRefundForm ? "Batal Refund" : "Refund Tunai"}
              </Button>
            </div>
          )}
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-slate-400">Jumlah Awal</dt>
            <dd className="font-mono text-black">{credit.amount.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Sudah Dipakai</dt>
            <dd className="font-mono text-black">{used.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Sisa</dt>
            <dd className="font-mono font-medium text-black">{remaining.toLocaleString("id-ID")}</dd>
          </div>
        </dl>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Jurnal Terkait</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {journalEntries.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Deskripsi</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Baris</th>
            </tr>
          </thead>
          <tbody>
            {journalEntries.map((entry) => (
              <tr key={entry.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{entry.entry_date}</td>
                <td className="px-4 py-2">
                  {entry.description}
                  {entry.reverses_entry_id && (
                    <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                      Reversal
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">{entry.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {entry.journal_lines.map((line) => (
                      <li key={line.id}>
                        {line.accounts.code} {line.accounts.name} —{" "}
                        {line.debit > 0
                          ? `D ${line.debit.toLocaleString("id-ID")}`
                          : `K ${line.credit.toLocaleString("id-ID")}`}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
            {journalEntries.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada jurnal.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Diterapkan ke Invoice</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {credit.ar_customer_credit_applications.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Invoice</th>
              <th className="px-4 py-2 text-right">Nominal</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {activeApplications.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2">{a.source_ref}</td>
                <td className="px-4 py-2">{a.ar_invoices.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">{a.amount.toLocaleString("id-ID")}</td>
                <td className="px-4 py-2">
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">Aktif</span>
                </td>
              </tr>
            ))}
            {reversedApplications.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 text-slate-400 hover:bg-slate-50">
                <td className="px-4 py-2 line-through">{a.source_ref}</td>
                <td className="px-4 py-2 line-through">{a.ar_invoices.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono line-through">
                  {a.amount.toLocaleString("id-ID")}
                </td>
                <td className="px-4 py-2">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                    Dibatalkan (invoice-nya dibatalkan)
                  </span>
                </td>
              </tr>
            ))}
            {credit.ar_customer_credit_applications.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum pernah diterapkan ke invoice.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Refund Tunai</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {credit.ar_customer_credit_refunds.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2 text-right">Nominal</th>
            </tr>
          </thead>
          <tbody>
            {credit.ar_customer_credit_refunds.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{r.created_at.slice(0, 10)}</td>
                <td className="px-4 py-2">{r.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">{r.amount.toLocaleString("id-ID")}</td>
              </tr>
            ))}
            {credit.ar_customer_credit_refunds.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                  Belum pernah direfund.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showApplyForm && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Pakai Saldo Kredit ke Invoice Lain</h2>
          <p className="mb-4 text-sm text-slate-600">
            Motong outstanding invoice lain milik customer yang sama pakai sisa saldo kredit ini —
            bukan pembayaran baru.
          </p>
          <form onSubmit={handleApplySubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_invoice">Invoice</Label>
                <Select
                  id="apply_invoice"
                  value={applyInvoiceId}
                  onChange={(e) => {
                    setApplyInvoiceId(e.target.value);
                    const found = outstandingInvoices.find((x) => x.invoice.id === e.target.value);
                    if (found) {
                      setApplyAmount(String(Math.min(remaining, found.outstanding)));
                    }
                  }}
                >
                  <option value="">Pilih invoice...</option>
                  {outstandingInvoices.map(({ invoice, outstanding }) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.source_ref} — sisa {outstanding.toLocaleString("id-ID")}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_amount">Nominal Diterapkan (maks {remaining.toLocaleString("id-ID")})</Label>
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_source_ref">Rujukan dokumen</Label>
                <Input
                  id="apply_source_ref"
                  placeholder="mis. Nota Kue #001"
                  value={applySourceRef}
                  onChange={(e) => setApplySourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_customer_credit_account">Akun Saldo Kredit Customer (debit)</Label>
                <Select
                  id="apply_customer_credit_account"
                  value={applyCustomerCreditAccountId}
                  onChange={(e) => setApplyCustomerCreditAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_receivable_account">Akun Piutang Usaha (kredit)</Label>
                <Select
                  id="apply_receivable_account"
                  value={applyReceivableAccountId}
                  onChange={(e) => setApplyReceivableAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {applyError && <FormError>{applyError}</FormError>}

            <Button type="submit" disabled={applySubmitting} className="w-fit">
              {applySubmitting ? "Menyimpan..." : "Terapkan"}
            </Button>
          </form>
        </div>
      )}

      {showRefundForm && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Refund Tunai Saldo Kredit</h2>
          <p className="mb-4 text-sm text-slate-600">
            Kembalikan sisa saldo kredit ini ke customer dalam bentuk kas/bank.
          </p>
          <form onSubmit={handleRefundSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_source_ref">Rujukan dokumen</Label>
                <Input
                  id="refund_source_ref"
                  placeholder="mis. Bukti transfer refund #1"
                  value={refundSourceRef}
                  onChange={(e) => setRefundSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_customer_credit_account">Akun Saldo Kredit Customer (debit)</Label>
                <Select
                  id="refund_customer_credit_account"
                  value={refundCustomerCreditAccountId}
                  onChange={(e) => setRefundCustomerCreditAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_cash_account">Akun Kas/Bank (kredit)</Label>
                <Select
                  id="refund_cash_account"
                  value={refundCashAccountId}
                  onChange={(e) => setRefundCashAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {refundError && <FormError>{refundError}</FormError>}

            <Button type="submit" disabled={refundSubmitting} className="w-fit">
              {refundSubmitting ? "Menyimpan..." : "Refund"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
