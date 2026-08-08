"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Supplier } from "@/lib/suppliers/schema";
import { billStatus, type ApBill } from "@/lib/ap-bills/schema";
import type { ApPayment } from "@/lib/ap-payments/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

const statusStyle: Record<string, string> = {
  lunas: "bg-emerald-50 text-emerald-700",
  sebagian: "bg-amber-50 text-amber-700",
  belum: "bg-slate-100 text-slate-600",
  dibatalkan: "bg-slate-100 text-slate-400 line-through",
};

export function SupplierDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [bills, setBills] = useState<ApBill[]>([]);
  const [payments, setPayments] = useState<ApPayment[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [
      { data: sup, error: supErr },
      { data: bl, error: blErr },
      { data: pay, error: payErr },
      { data: reversed },
    ] = await Promise.all([
      supabase
        .from("suppliers")
        .select("id, name, contact, payment_term_days, archived_at")
        .eq("id", id)
        .single(),
      supabase
        .from("ap_bills")
        .select(
          "id, supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id, created_at, suppliers(name), ap_payments(amount)"
        )
        .eq("supplier_id", id)
        .order("bill_date", { ascending: false }),
      supabase
        .from("ap_payments")
        .select(
          "id, supplier_id, bill_id, payment_date, amount, source_ref, journal_entry_id, created_at, suppliers(name), ap_bills(source_ref)"
        )
        .eq("supplier_id", id)
        .order("payment_date", { ascending: false }),
      supabase.from("journal_entries").select("reverses_entry_id").not("reverses_entry_id", "is", null),
    ]);
    if (supErr) {
      setLoadError(supErr.message);
      return;
    }
    setLoadError(blErr?.message ?? payErr?.message ?? null);
    setSupplier(sup as Supplier);
    setBills((bl ?? []) as unknown as ApBill[]);
    setPayments((pay ?? []) as unknown as ApPayment[]);
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

  if (!supplier) {
    return <FormError>{loadError ?? "Supplier gak ditemukan."}</FormError>;
  }

  const totalOutstanding = bills.reduce((sum, bill) => {
    const isCancelled = reversedEntryIds.has(bill.journal_entry_id);
    return sum + billStatus(bill, isCancelled).outstanding;
  }, 0);

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <BackLink href="/suppliers" label="Kembali ke Suppliers" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-black">{supplier.name}</h1>
          <p className="text-sm text-slate-500">
            {supplier.contact ?? "-"} · Termin net-{supplier.payment_term_days}
            {supplier.archived_at && " · Diarsipkan"}
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
          <span className="text-sm font-medium text-black">AP Bills</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {bills.length}
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
            {bills.map((bill) => {
              const isCancelled = reversedEntryIds.has(bill.journal_entry_id);
              const { status, outstanding } = billStatus(bill, isCancelled);
              const overdue =
                status !== "lunas" &&
                status !== "dibatalkan" &&
                bill.due_date < new Date().toISOString().slice(0, 10);
              return (
                <tr key={bill.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">{bill.bill_date}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {bill.due_date}
                    {overdue && (
                      <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
                        Telat
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{bill.source_ref}</td>
                  <td className="px-4 py-2 text-right font-mono">{bill.amount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2 text-right font-mono">{outstanding.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyle[status]}`}>
                      {status}
                    </span>
                  </td>
                </tr>
              );
            })}
            {bills.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada bill.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">AP Payments</span>
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
              <th className="px-4 py-2">Bill</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{p.payment_date}</td>
                <td className="px-4 py-2">{p.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">{p.amount.toLocaleString("id-ID")}</td>
                <td className="px-4 py-2">{p.ap_bills.source_ref}</td>
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
