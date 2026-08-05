"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { Customer } from "@/lib/customers/schema";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import { recordArPaymentSchema, type ArPayment } from "@/lib/ar-payments/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type AllocationInput = { invoice_id: string; amount: string };

function emptyAllocation(): AllocationInput {
  return { invoice_id: "", amount: "" };
}

export default function ArPaymentsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<ArInvoice[]>([]);
  const [payments, setPayments] = useState<ArPayment[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [amount, setAmount] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [receivableAccountId, setReceivableAccountId] = useState("");
  const [customerCreditAccountId, setCustomerCreditAccountId] = useState("");
  const [allocations, setAllocations] = useState<AllocationInput[]>([emptyAllocation()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const loadPayments = useCallback(async () => {
    const { data, error } = await supabase
      .from("ar_payments")
      .select(
        "id, customer_id, payment_date, amount, source_ref, journal_entry_id, created_at, customers(name), ar_payment_allocations(id, amount, ar_invoices(source_ref))"
      )
      .order("payment_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setPayments((data ?? []) as unknown as ArPayment[]);
  }, []);

  const loadInvoices = useCallback(async () => {
    const { data } = await supabase
      .from("ar_invoices")
      .select(
        "id, customer_id, invoice_date, due_date, return_window_days, description, source_ref, amount, journal_entry_id, created_at, customers(name), ar_payment_allocations(amount), ar_deposit_applications(amount), ar_customer_credit_applications(amount)"
      )
      .order("invoice_date");
    setInvoices((data ?? []) as unknown as ArInvoice[]);
  }, []);

  const loadCustomers = useCallback(async () => {
    const { data } = await supabase
      .from("customers")
      .select("id, name, contact, payment_term_days, archived_at")
      .order("name");
    setCustomers((data ?? []) as Customer[]);
  }, []);

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from("accounts")
      .select("id, code, name, category, normal_balance, parent_id, archived_at")
      .order("code");
    setAccounts((data ?? []) as Account[]);
  }, []);

  const loadReversedEntryIds = useCallback(async () => {
    const { data } = await supabase
      .from("journal_entries")
      .select("reverses_entry_id")
      .not("reverses_entry_id", "is", null);
    setReversedEntryIds(
      new Set(((data ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
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
      await Promise.all([
        loadCustomers(),
        loadAccounts(),
        loadInvoices(),
        loadPayments(),
        loadReversedEntryIds(),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadAccounts, loadInvoices, loadPayments, loadReversedEntryIds]);

  const outstandingInvoices = invoices
    .filter((inv) => inv.customer_id === customerId)
    .map((inv) => ({ invoice: inv, ...invoiceStatus(inv, reversedEntryIds.has(inv.journal_entry_id)) }))
    .filter((x) => x.status !== "lunas" && x.status !== "dibatalkan");

  function updateAllocation(index: number, patch: Partial<AllocationInput>) {
    setAllocations((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }

  function addAllocation() {
    setAllocations((prev) => [...prev, emptyAllocation()]);
  }

  function removeAllocation(index: number) {
    setAllocations((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  const totalAllocated = allocations.reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
  const amountNumber = parseFloat(amount) || 0;
  const excess = amountNumber - totalAllocated;
  const hasExcess = excess > 0.005;
  const isBalanced =
    amountNumber > 0 && totalAllocated <= amountNumber + 0.005 && (!hasExcess || !!customerCreditAccountId);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = recordArPaymentSchema.safeParse({
      customer_id: customerId,
      payment_date: paymentDate,
      amount,
      source_ref: sourceRef,
      cash_account_id: cashAccountId,
      receivable_account_id: receivableAccountId,
      allocations: allocations.map((a) => ({ invoice_id: a.invoice_id, amount: a.amount })),
      customer_credit_account_id: customerCreditAccountId || undefined,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("record_ar_payment", {
      p_customer_id: parsed.data.customer_id,
      p_payment_date: parsed.data.payment_date,
      p_amount: parsed.data.amount,
      p_source_ref: parsed.data.source_ref,
      p_cash_account_id: parsed.data.cash_account_id,
      p_receivable_account_id: parsed.data.receivable_account_id,
      p_allocations: parsed.data.allocations,
      p_customer_credit_account_id: parsed.data.customer_credit_account_id ?? null,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setCustomerId("");
    setPaymentDate("");
    setAmount("");
    setSourceRef("");
    setCashAccountId("");
    setReceivableAccountId("");
    setCustomerCreditAccountId("");
    setAllocations([emptyAllocation()]);
    setShowForm(false);
    await Promise.all([loadInvoices(), loadPayments()]);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">AR Payments — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">AR Payments</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {payments.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadPayments()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm((v) => !v)}>
                + New
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Alokasi ke Invoice</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                <td className="px-4 py-2 font-medium text-black">{p.customers.name}</td>
                <td className="whitespace-nowrap px-4 py-2">{p.payment_date}</td>
                <td className="px-4 py-2">{p.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {p.ar_payment_allocations.map((a) => (
                      <li key={a.id}>
                        {a.ar_invoices.source_ref} — {a.amount.toLocaleString("id-ID")}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {p.amount.toLocaleString("id-ID")}
                </td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Belum ada payment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Catat AR Payment</h2>
          {!canWrite && (
            <p className="mb-4 text-sm text-amber-600">
              Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
              ketolak RLS.
            </p>
          )}
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customer">Customer</Label>
                <Select
                  id="customer"
                  value={customerId}
                  onChange={(e) => {
                    setCustomerId(e.target.value);
                    setAllocations([emptyAllocation()]);
                  }}
                >
                  <option value="">Pilih customer...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payment_date">Tanggal</Label>
                <Input
                  id="payment_date"
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source_ref">Rujukan dokumen (source_ref)</Label>
                <Input
                  id="source_ref"
                  placeholder="mis. Bukti transfer #1"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="amount">Jumlah dibayar</Label>
                <Input
                  id="amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cash_account">Akun Kas/Bank (debit)</Label>
                <Select id="cash_account" value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}>
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="receivable_account">Akun Piutang Usaha (kredit)</Label>
                <Select
                  id="receivable_account"
                  value={receivableAccountId}
                  onChange={(e) => setReceivableAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              {hasExcess && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="customer_credit_account">Akun Saldo Kredit Customer (kredit, buat kelebihan bayar)</Label>
                  <Select
                    id="customer_credit_account"
                    value={customerCreditAccountId}
                    onChange={(e) => setCustomerCreditAccountId(e.target.value)}
                  >
                    <option value="">Pilih akun...</option>
                    {leafAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_8rem_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Invoice outstanding</span>
                <span>Alokasi</span>
                <span />
              </div>
              {!customerId && (
                <p className="text-sm text-slate-400">Pilih customer dulu buat lihat invoice outstanding.</p>
              )}
              {allocations.map((alloc, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_2.5rem] gap-2">
                  <Select
                    value={alloc.invoice_id}
                    onChange={(e) => updateAllocation(i, { invoice_id: e.target.value })}
                    disabled={!customerId}
                  >
                    <option value="">Pilih invoice...</option>
                    {outstandingInvoices.map(({ invoice, outstanding }) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.source_ref} — sisa {outstanding.toLocaleString("id-ID")}
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={alloc.amount}
                    onChange={(e) => updateAllocation(i, { amount: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => removeAllocation(i)}
                    disabled={allocations.length <= 1}
                    className="text-slate-400 hover:text-red-600 disabled:opacity-30"
                    aria-label="Hapus alokasi"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={addAllocation} className="w-fit" disabled={!customerId}>
                + Tambah alokasi
              </Button>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <span>
                Total alokasi:{" "}
                <strong className="font-mono">{totalAllocated.toLocaleString("id-ID")}</strong> — Jumlah
                dibayar: <strong className="font-mono">{amountNumber.toLocaleString("id-ID")}</strong>
                {hasExcess && (
                  <>
                    {" "}
                    — Sisa jadi saldo kredit:{" "}
                    <strong className="font-mono">{excess.toLocaleString("id-ID")}</strong>
                  </>
                )}
              </span>
              <span className={isBalanced ? "font-medium text-emerald-600" : "font-medium text-red-600"}>
                {isBalanced ? "Cocok ✓" : "Belum cocok"}
              </span>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting || !isBalanced} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan Payment"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
