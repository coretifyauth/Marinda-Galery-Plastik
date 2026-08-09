"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { Customer } from "@/lib/customers/schema";
import { createArDepositSchema, depositStatus, type ArDeposit } from "@/lib/ar-deposits/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

const statusLabel: Record<string, string> = {
  belum_dipakai: "Belum Dipakai",
  sebagian: "Sebagian Terpakai",
  selesai: "Selesai",
};

const statusStyle: Record<string, string> = {
  belum_dipakai: "bg-slate-100 text-slate-600",
  sebagian: "bg-amber-50 text-amber-700",
  selesai: "bg-emerald-50 text-emerald-700",
};

export default function ArDepositsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [deposits, setDeposits] = useState<ArDeposit[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [depositDate, setDepositDate] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [amount, setAmount] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [depositLiabilityAccountId, setDepositLiabilityAccountId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const loadReversedEntryIds = useCallback(async () => {
    const { data } = await supabase
      .from("journal_entries")
      .select("reverses_entry_id")
      .not("reverses_entry_id", "is", null);
    setReversedEntryIds(
      new Set(((data ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
  }, []);

  const loadDeposits = useCallback(async () => {
    const { data, error } = await supabase
      .from("ar_deposits")
      .select(
        "id, customer_id, deposit_date, source_ref, amount, journal_entry_id, created_at, customers(name), ar_deposit_applications(id, amount, source_ref, journal_entry_id, ar_invoices(source_ref)), ar_deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ar_deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
      )
      .order("deposit_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setDeposits((data ?? []) as unknown as ArDeposit[]);
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
      await Promise.all([loadCustomers(), loadAccounts(), loadDeposits(), loadReversedEntryIds()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadAccounts, loadDeposits, loadReversedEntryIds]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createArDepositSchema.safeParse({
      customer_id: customerId,
      deposit_date: depositDate,
      source_ref: sourceRef,
      amount,
      cash_account_id: cashAccountId,
      deposit_liability_account_id: depositLiabilityAccountId,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_ar_deposit", {
      p_customer_id: parsed.data.customer_id,
      p_deposit_date: parsed.data.deposit_date,
      p_source_ref: parsed.data.source_ref,
      p_amount: parsed.data.amount,
      p_cash_account_id: parsed.data.cash_account_id,
      p_deposit_liability_account_id: parsed.data.deposit_liability_account_id,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setCustomerId("");
    setDepositDate("");
    setSourceRef("");
    setAmount("");
    setCashAccountId("");
    setDepositLiabilityAccountId("");
    setShowForm(false);
    await loadDeposits();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">AR Deposits (Uang Muka) — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">AR Deposits</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {deposits.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadDeposits()}>
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
              <th className="px-4 py-2 text-right">Jumlah</th>
              <th className="px-4 py-2 text-right">Sisa</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {deposits.map((dep) => {
              const { status, remaining } = depositStatus(dep, reversedEntryIds);
              return (
                <tr
                  key={dep.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/ar-deposits/${dep.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{dep.customers.name}</td>
                  <td className="whitespace-nowrap px-4 py-2">{dep.deposit_date}</td>
                  <td className="px-4 py-2">{dep.source_ref}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {dep.amount.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {remaining.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[status]}`}>
                      {statusLabel[status]}
                    </span>
                  </td>
                </tr>
              );
            })}
            {deposits.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada deposit.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Terima Uang Muka</h2>
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
                <Select id="customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">Pilih customer...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="deposit_date">Tanggal</Label>
                <Input
                  id="deposit_date"
                  type="date"
                  value={depositDate}
                  onChange={(e) => setDepositDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source_ref">Rujukan dokumen (source_ref)</Label>
                <Input
                  id="source_ref"
                  placeholder="mis. DP Kue Ultah Ibu Dewi"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="amount">Jumlah</Label>
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
                <Label htmlFor="deposit_liability_account">Akun Uang Muka Penjualan (kredit)</Label>
                <Select
                  id="deposit_liability_account"
                  value={depositLiabilityAccountId}
                  onChange={(e) => setDepositLiabilityAccountId(e.target.value)}
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

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan Deposit"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
