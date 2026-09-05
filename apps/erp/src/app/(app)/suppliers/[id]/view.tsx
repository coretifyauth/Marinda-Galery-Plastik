"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Supplier } from "@/lib/suppliers/schema";
import { billStatus, type ApBill } from "@/lib/ap-bills/schema";
import type { ApPayment } from "@/lib/ap-payments/schema";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Button } from "@/components/ui/button";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";

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
  const [activeTab, setActiveTab] = useState("bills");
  const [roles, setRoles] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const [
      { data: sup, error: supErr },
      { data: bl, error: blErr },
      { data: pay, error: payErr },
      { data: reversed },
    ] = await Promise.all([
      supabase
        .from("counterparties")
        .select("id, name, contact, payment_term_days, archived_at")
        .eq("id", id)
        .single(),
      supabase
        .from("transactions")
        .select(
          "id, supplier_id:counterparty_id, bill_date:date, due_date, description, source_ref, amount, journal_entry_id, created_at, counterparties(name), ap_payments:payments(amount), ap_credit_notes:credit_notes(amount, ap_return_credits(amount)), ap_deposit_applications:deposit_applications(amount)"
        )
        .eq("type", "OUTBOUND")
        .eq("counterparty_id", id)
        .order("date", { ascending: false }),
      supabase
        .from("payments")
        .select(
          "id, supplier_id:counterparty_id, bill_id:transaction_id, payment_date, amount, source_ref, journal_entry_id, created_at, counterparties(name), ap_bills:transactions(source_ref)"
        )
        .eq("type", "OUTBOUND")
        .eq("counterparty_id", id)
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

  async function handleDelete() {
    if (!supplier) return;
    if (!window.confirm(`Hapus supplier "${supplier.name}"?`)) return;
    setDeleteError(null);
    setDeleting(true);
    const { data, error } = await supabase.rpc("delete_counterparty", { p_counterparty_id: supplier.id });
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    if (data === "deleted") {
      router.push("/suppliers");
      return;
    }
    window.alert("Supplier ini sudah pernah dipakai di transaksi, jadi diarsipkan (bukan dihapus permanen).");
    await load();
  }

  async function handleReactivate() {
    if (!supplier) return;
    setDeleteError(null);
    setDeleting(true);
    const { error } = await supabase.from("counterparties").update({ archived_at: null }).eq("id", supplier.id);
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!supplier) {
    return <FormError>{loadError ?? "Supplier gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  const totalOutstanding = bills.reduce((sum, bill) => {
    const isCancelled = reversedEntryIds.has(bill.journal_entry_id);
    return sum + billStatus(bill, isCancelled).outstanding;
  }, 0);

  const detailGroups = [
    {
      title: "Informasi Supplier",
      rows: [
        { label: "Nama", value: supplier.name },
        { label: "Kontak", value: supplier.contact ?? "-" },
        { label: "Termin", value: `net-${supplier.payment_term_days}` },
        { label: "Status", value: supplier.archived_at ? "Diarsipkan" : "Aktif" },
      ],
    },
    {
      title: "Ringkasan",
      rows: [{ label: "Total Outstanding", value: totalOutstanding.toLocaleString("id-ID") }],
    },
  ];

  const tabs: TabDef[] = [
    { key: "bills", label: "AP Bills", badge: bills.length },
    { key: "payments", label: "AP Payments", badge: payments.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/suppliers" label="Kembali ke Suppliers" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Supplier Details</h1>
        {canWrite && (
          <div className="flex gap-2">
            {supplier.archived_at ? (
              <Button variant="toolbar" onClick={handleReactivate} disabled={deleting}>
                {deleting ? "Memproses..." : "Aktifkan"}
              </Button>
            ) : (
              <Button variant="toolbar" onClick={handleDelete} disabled={deleting}>
                {deleting ? "Memproses..." : "Hapus"}
              </Button>
            )}
          </div>
        )}
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {deleteError && <FormError>{deleteError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "bills" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
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
                        <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">Telat</span>
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
      )}

      {activeTab === "payments" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
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
      )}
    </div>
  );
}
