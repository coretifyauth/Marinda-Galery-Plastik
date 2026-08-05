"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { Customer } from "@/lib/customers/schema";
import { createArInvoiceSchema, invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

const statusStyle: Record<string, string> = {
  lunas: "bg-emerald-50 text-emerald-700",
  sebagian: "bg-amber-50 text-amber-700",
  belum: "bg-slate-100 text-slate-600",
  dibatalkan: "bg-slate-100 text-slate-400 line-through",
  dihapusbukukan: "bg-red-50 text-red-700",
};

export default function ArInvoicesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<ArInvoice[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [description, setDescription] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [amount, setAmount] = useState("");
  const [receivableAccountId, setReceivableAccountId] = useState("");
  const [revenueAccountId, setRevenueAccountId] = useState("");
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

  const loadInvoices = useCallback(async () => {
    const { data, error } = await supabase
      .from("ar_invoices")
      .select(
        "id, customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_at, customers(name), ar_payment_allocations(amount), ar_credit_notes(amount), ar_deposit_applications(amount), ar_customer_credit_applications(amount), ar_bad_debt_writeoffs(amount), ar_return_credit_applications(amount)"
      )
      .order("invoice_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
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
      await Promise.all([loadCustomers(), loadAccounts(), loadInvoices(), loadReversedEntryIds()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadAccounts, loadInvoices, loadReversedEntryIds]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createArInvoiceSchema.safeParse({
      customer_id: customerId,
      invoice_date: invoiceDate,
      description,
      source_ref: sourceRef,
      amount,
      receivable_account_id: receivableAccountId,
      revenue_account_id: revenueAccountId,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_ar_invoice", {
      p_customer_id: parsed.data.customer_id,
      p_invoice_date: parsed.data.invoice_date,
      p_description: parsed.data.description || null,
      p_source_ref: parsed.data.source_ref,
      p_amount: parsed.data.amount,
      p_receivable_account_id: parsed.data.receivable_account_id,
      p_revenue_account_id: parsed.data.revenue_account_id,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setCustomerId("");
    setInvoiceDate("");
    setDescription("");
    setSourceRef("");
    setAmount("");
    setReceivableAccountId("");
    setRevenueAccountId("");
    setShowForm(false);
    await loadInvoices();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">AR Invoices — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">AR Invoices</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {invoices.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadInvoices()}>
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
              <th className="px-4 py-2">Jatuh Tempo</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
              <th className="px-4 py-2 text-right">Outstanding</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => {
              const isCancelled = reversedEntryIds.has(inv.journal_entry_id);
              const { status, outstanding, returned } = invoiceStatus(inv, isCancelled);
              const overdue =
                status !== "lunas" &&
                status !== "dibatalkan" &&
                status !== "dihapusbukukan" &&
                inv.due_date < new Date().toISOString().slice(0, 10);
              return (
                <tr
                  key={inv.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/ar-invoices/${inv.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{inv.customers.name}</td>
                  <td className="whitespace-nowrap px-4 py-2">{inv.invoice_date}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {inv.due_date}
                    {overdue && (
                      <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
                        Telat
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{inv.source_ref}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {inv.amount.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {outstanding.toLocaleString("id-ID")}
                    {returned > 0 && (
                      <span className="ml-1 block text-xs font-normal text-amber-600">
                        retur {returned.toLocaleString("id-ID")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyle[status]}`}>
                      {status}
                    </span>
                  </td>
                </tr>
              );
            })}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-400">
                  Belum ada invoice.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Tambah AR Invoice</h2>
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
                      {c.name} (net-{c.payment_term_days})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invoice_date">Tanggal</Label>
                <Input
                  id="invoice_date"
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source_ref">Rujukan dokumen (source_ref)</Label>
                <Input
                  id="source_ref"
                  placeholder="mis. Nota grosir #005"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="description">Deskripsi</Label>
                <Input
                  id="description"
                  placeholder="mis. Kirim roti ke Warung Bu Imas"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
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
                <Label htmlFor="receivable_account">Akun Piutang Usaha (debit)</Label>
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="revenue_account">Akun Pendapatan (kredit)</Label>
                <Select
                  id="revenue_account"
                  value={revenueAccountId}
                  onChange={(e) => setRevenueAccountId(e.target.value)}
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
              {submitting ? "Menyimpan..." : "Simpan Invoice"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
