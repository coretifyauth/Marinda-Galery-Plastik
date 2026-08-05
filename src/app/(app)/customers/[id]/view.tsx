"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { createCustomerSchema, type Customer } from "@/lib/customers/schema";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import type { ArPayment } from "@/lib/ar-payments/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const statusStyle: Record<string, string> = {
  lunas: "bg-emerald-50 text-emerald-700",
  sebagian: "bg-amber-50 text-amber-700",
  belum: "bg-slate-100 text-slate-600",
  dibatalkan: "bg-slate-100 text-slate-400 line-through",
};

export function CustomerDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [invoices, setInvoices] = useState<ArInvoice[]>([]);
  const [payments, setPayments] = useState<ArPayment[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editContact, setEditContact] = useState("");
  const [editPaymentTermDays, setEditPaymentTermDays] = useState("");
  const [editCreditLimit, setEditCreditLimit] = useState("");
  const [editOverdueThresholdDays, setEditOverdueThresholdDays] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [
      { data: cust, error: custErr },
      { data: inv, error: invErr },
      { data: pay, error: payErr },
      { data: reversed },
    ] = await Promise.all([
      supabase
        .from("customers")
        .select("id, name, contact, payment_term_days, credit_limit, overdue_threshold_days, archived_at")
        .eq("id", id)
        .single(),
      supabase
        .from("ar_invoices")
        .select(
          "id, customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_at, customers(name), ar_payment_allocations(amount), ar_credit_notes(amount), ar_deposit_applications(amount), ar_customer_credit_applications(amount)"
        )
        .eq("customer_id", id)
        .order("invoice_date", { ascending: false }),
      supabase
        .from("ar_payments")
        .select(
          "id, customer_id, payment_date, amount, source_ref, journal_entry_id, created_at, customers(name), ar_payment_allocations(id, amount, ar_invoices(source_ref))"
        )
        .eq("customer_id", id)
        .order("payment_date", { ascending: false }),
      supabase.from("journal_entries").select("reverses_entry_id").not("reverses_entry_id", "is", null),
    ]);
    if (custErr) {
      setLoadError(custErr.message);
      return;
    }
    setLoadError(invErr?.message ?? payErr?.message ?? null);
    const c = cust as Customer;
    setCustomer(c);
    setEditName(c.name);
    setEditContact(c.contact ?? "");
    setEditPaymentTermDays(String(c.payment_term_days));
    setEditCreditLimit(c.credit_limit != null ? String(c.credit_limit) : "");
    setEditOverdueThresholdDays(c.overdue_threshold_days != null ? String(c.overdue_threshold_days) : "");
    setInvoices((inv ?? []) as unknown as ArInvoice[]);
    setPayments((pay ?? []) as unknown as ArPayment[]);
    setReversedEntryIds(
      new Set(((reversed ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
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

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    setEditError(null);
    const parsed = createCustomerSchema.safeParse({
      name: editName,
      contact: editContact || undefined,
      payment_term_days: editPaymentTermDays,
      credit_limit: editCreditLimit || undefined,
      overdue_threshold_days: editOverdueThresholdDays || undefined,
    });
    if (!parsed.success) {
      setEditError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("customers")
      .update({
        name: parsed.data.name,
        contact: parsed.data.contact ?? null,
        payment_term_days: parsed.data.payment_term_days,
        credit_limit: parsed.data.credit_limit ?? null,
        overdue_threshold_days: parsed.data.overdue_threshold_days ?? null,
      })
      .eq("id", id);
    setSaving(false);
    if (error) {
      setEditError(error.message);
      return;
    }
    setEditing(false);
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!customer) {
    return <FormError>{loadError ?? "Customer gak ditemukan."}</FormError>;
  }

  const today = new Date().toISOString().slice(0, 10);
  let totalOutstanding = 0;
  let maxOverdueDays = 0;
  for (const inv of invoices) {
    const isCancelled = reversedEntryIds.has(inv.journal_entry_id);
    const { outstanding } = invoiceStatus(inv, isCancelled);
    if (outstanding <= 0) continue;
    totalOutstanding += outstanding;
    const overdueDays = Math.floor(
      (Date.parse(today) - Date.parse(inv.due_date)) / (1000 * 60 * 60 * 24)
    );
    if (overdueDays > maxOverdueDays) maxOverdueDays = overdueDays;
  }
  const isOnHold =
    (customer.credit_limit != null && totalOutstanding > customer.credit_limit) ||
    (customer.overdue_threshold_days != null && maxOverdueDays > customer.overdue_threshold_days);
  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <BackLink href="/customers" label="Kembali ke Customers" />
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-black">{customer.name}</h1>
            {isOnHold && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                Credit Hold
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500">
            {customer.contact ?? "-"} · Termin net-{customer.payment_term_days} · Credit limit{" "}
            {customer.credit_limit != null ? customer.credit_limit.toLocaleString("id-ID") : "tanpa batas"}
            {" "}· Toleransi telat {customer.overdue_threshold_days ?? "tanpa batas"} hari
            {customer.archived_at && " · Diarsipkan"}
          </p>
        </div>
        <div className="flex items-start gap-4">
          <div className="text-right">
            <div className="text-xs uppercase text-slate-400">Total Outstanding</div>
            <div className="font-mono text-lg font-medium text-black">
              {totalOutstanding.toLocaleString("id-ID")}
            </div>
          </div>
          {canWrite && (
            <Button variant="toolbar" onClick={() => setEditing((v) => !v)}>
              {editing ? "Batal" : "Edit"}
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Edit Customer</h2>
          <form onSubmit={handleSaveEdit} className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_name">Nama</Label>
              <Input id="edit_name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_contact">Kontak</Label>
              <Input id="edit_contact" value={editContact} onChange={(e) => setEditContact(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_payment_term_days">Termin (hari)</Label>
              <Input
                id="edit_payment_term_days"
                type="number"
                min="1"
                value={editPaymentTermDays}
                onChange={(e) => setEditPaymentTermDays(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_credit_limit">Credit Limit (kosongkan = tanpa batas)</Label>
              <Input
                id="edit_credit_limit"
                type="number"
                min="0"
                value={editCreditLimit}
                onChange={(e) => setEditCreditLimit(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_overdue_threshold_days">Toleransi Telat (hari, kosongkan = tanpa batas)</Label>
              <Input
                id="edit_overdue_threshold_days"
                type="number"
                min="1"
                value={editOverdueThresholdDays}
                onChange={(e) => setEditOverdueThresholdDays(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? "Menyimpan..." : "Simpan"}
            </Button>
          </form>
          {editError && (
            <div className="mt-3">
              <FormError>{editError}</FormError>
            </div>
          )}
        </div>
      )}

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">AR Invoices</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {invoices.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
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
              const { status, outstanding } = invoiceStatus(inv, isCancelled);
              const overdue =
                status !== "lunas" &&
                status !== "dibatalkan" &&
                inv.due_date < new Date().toISOString().slice(0, 10);
              return (
                <tr key={inv.id} className="border-b border-slate-100 hover:bg-slate-50">
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
                  <td className="px-4 py-2 text-right font-mono">{inv.amount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2 text-right font-mono">{outstanding.toLocaleString("id-ID")}</td>
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
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada invoice.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">AR Payments</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {payments.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
              <th className="px-4 py-2">Dialokasikan ke</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{p.payment_date}</td>
                <td className="px-4 py-2">{p.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">{p.amount.toLocaleString("id-ID")}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {p.ar_payment_allocations.map((a) => (
                      <li key={a.id}>
                        {a.ar_invoices.source_ref} — {a.amount.toLocaleString("id-ID")}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada pembayaran.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
