"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

type PaymentDetail = {
  id: string;
  customer_id: string;
  invoice_id: string;
  payment_date: string;
  source_ref: string;
  amount: number;
  journal_entry_id: string;
  created_at: string;
  customers: { name: string };
  ar_invoices: { source_ref: string; amount: number };
};

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  reverses_entry_id: string | null;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

export function ArPaymentDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [payment, setPayment] = useState<PaymentDetail | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: pay, error: payErr } = await supabase
      .from("ar_payments")
      .select(
        "id, customer_id, invoice_id, payment_date, source_ref, amount, journal_entry_id, created_at, customers(name), ar_invoices(source_ref, amount)"
      )
      .eq("id", id)
      .single();
    if (payErr || !pay) {
      setLoadError(payErr?.message ?? "Payment gak ditemukan.");
      return;
    }
    const loadedPayment = pay as unknown as PaymentDetail;
    setPayment(loadedPayment);

    const { data: entries, error: entriesErr } = await supabase
      .from("journal_entries")
      .select(
        "id, entry_date, description, source_ref, reverses_entry_id, journal_lines(id, debit, credit, accounts(code, name))"
      )
      .or(`id.eq.${loadedPayment.journal_entry_id},reverses_entry_id.eq.${loadedPayment.journal_entry_id}`)
      .order("entry_date");

    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setLoadError(entriesErr?.message ?? null);
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      if (!active) return;
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

  if (!payment) {
    return <FormError>{loadError ?? "Payment gak ditemukan."}</FormError>;
  }

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/ar-payments" label="Kembali ke AR Payments" />
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-black">
            {payment.customers.name} — {payment.source_ref}
          </h1>
          <p className="text-sm text-slate-500">{payment.payment_date}</p>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-slate-400">Jumlah Dibayar</div>
          <div className="font-mono text-lg font-medium text-black">
            {payment.amount.toLocaleString("id-ID")}
          </div>
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Invoice yang Dilunasi</span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Invoice</th>
              <th className="px-4 py-2 text-right">Nominal Invoice</th>
              <th className="px-4 py-2 text-right">Dibayar</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-2">{payment.ar_invoices.source_ref}</td>
              <td className="px-4 py-2 text-right font-mono">{payment.ar_invoices.amount.toLocaleString("id-ID")}</td>
              <td className="px-4 py-2 text-right font-mono">{payment.amount.toLocaleString("id-ID")}</td>
            </tr>
          </tbody>
        </table>
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
    </div>
  );
}
