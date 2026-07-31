"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Customer } from "@/lib/customers/schema";
import { invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import type { ArPayment } from "@/lib/ar-payments/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

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

  const load = useCallback(async () => {
    const [
      { data: cust, error: custErr },
      { data: inv, error: invErr },
      { data: pay, error: payErr },
      { data: reversed },
    ] = await Promise.all([
      supabase
        .from("customers")
        .select("id, name, contact, payment_term_days, archived_at")
        .eq("id", id)
        .single(),
      supabase
        .from("ar_invoices")
        .select(
          "id, customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_at, customers(name), ar_payment_allocations(amount)"
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
    setCustomer(cust as Customer);
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
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!customer) {
    return <FormError>{loadError ?? "Customer gak ditemukan."}</FormError>;
  }

  const totalOutstanding = invoices.reduce((sum, inv) => {
    const isCancelled = reversedEntryIds.has(inv.journal_entry_id);
    return sum + invoiceStatus(inv, isCancelled).outstanding;
  }, 0);

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <BackLink href="/customers" label="Kembali ke Customers" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-black">{customer.name}</h1>
          <p className="text-sm text-slate-500">
            {customer.contact ?? "-"} · Termin net-{customer.payment_term_days}
            {customer.archived_at && " · Diarsipkan"}
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-slate-400">Total Outstanding</div>
          <div className="font-mono text-lg font-medium text-black">
            {totalOutstanding.toLocaleString("id-ID")}
          </div>
        </div>
      </div>

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
