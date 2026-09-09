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
import { Modal } from "@/components/ui/modal";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";

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
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("invoices");

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const [
      { data: cust, error: custErr },
      { data: inv, error: invErr },
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
          "id, customer_id:counterparty_id, invoice_date:date, due_date, description, source_ref, amount, journal_entry_id, created_at, counterparties(name), ar_payments:payments(amount), ar_returns:returns(amount, ar_return_credits:return_credits(amount)), ar_deposit_applications:deposit_applications(amount)"
        )
        .eq("type", "OUTBOUND")
        .eq("counterparty_id", id)
        .order("date", { ascending: false }),
      supabase
        .from("payments")
        .select(
          "id, customer_id:counterparty_id, invoice_id:transaction_id, payment_date, amount, source_ref, journal_entry_id, created_at, counterparties(name), ar_invoices:transactions(source_ref)"
        )
        .eq("type", "OUTBOUND")
        .eq("counterparty_id", id)
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
    });
    if (!parsed.success) {
      setEditError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("counterparties")
      .update({
        name: parsed.data.name,
        contact: parsed.data.contact ?? null,
        payment_term_days: parsed.data.payment_term_days,
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

  async function handleDelete() {
    if (!customer) return;
    if (!window.confirm(`Hapus customer "${customer.name}"?`)) return;
    setDeleteError(null);
    setDeleting(true);
    const { data, error } = await supabase.rpc("delete_counterparty", { p_counterparty_id: customer.id });
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    if (data === "deleted") {
      router.push("/customers");
      return;
    }
    window.alert("Customer ini sudah pernah dipakai di transaksi, jadi diarsipkan (bukan dihapus permanen).");
    await load();
  }

  async function handleReactivate() {
    if (!customer) return;
    setDeleteError(null);
    setDeleting(true);
    const { error } = await supabase.from("counterparties").update({ archived_at: null }).eq("id", customer.id);
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

  if (!customer) {
    return <FormError>{loadError ?? "Customer gak ditemukan."}</FormError>;
  }

  let totalOutstanding = 0;
  for (const inv of invoices) {
    const isCancelled = reversedEntryIds.has(inv.journal_entry_id);
    const { outstanding } = invoiceStatus(inv, isCancelled);
    if (outstanding > 0) totalOutstanding += outstanding;
  }
  const canWrite = roles.includes("admin") || roles.includes("accountant");

  const detailGroups = [
    {
      title: "Informasi Customer",
      rows: [
        { label: "Nama", value: customer.name },
        { label: "Kontak", value: customer.contact ?? "-" },
        { label: "Termin", value: `net-${customer.payment_term_days}` },
        {
          label: "Status",
          value: customer.archived_at ? "Diarsipkan" : "Aktif",
        },
      ],
    },
    {
      title: "Ringkasan",
      rows: [{ label: "Total Outstanding", value: totalOutstanding.toLocaleString("id-ID") }],
    },
  ];

  const tabs: TabDef[] = [
    { key: "invoices", label: "AR Invoices", badge: invoices.length },
    { key: "payments", label: "AR Payments", badge: payments.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/customers" label="Kembali ke Customers" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Customer Details</h1>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="toolbar" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {customer.archived_at ? (
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

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit Customer">
        <form onSubmit={handleSaveEdit} className="flex flex-col gap-4">
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
          {editError && <FormError>{editError}</FormError>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Menyimpan..." : "Simpan"}
            </Button>
          </div>
        </form>
      </Modal>

      {loadError && <FormError>{loadError}</FormError>}
      {deleteError && <FormError>{deleteError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "invoices" && (
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
                        <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">Telat</span>
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
      )}

      {activeTab === "payments" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="px-4 py-2">Tanggal</th>
                <th className="px-4 py-2">Source Ref</th>
                <th className="px-4 py-2 text-right">Jumlah</th>
                <th className="px-4 py-2">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2">{p.payment_date}</td>
                  <td className="px-4 py-2">{p.source_ref}</td>
                  <td className="px-4 py-2 text-right font-mono">{p.amount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2">{p.ar_invoices.source_ref}</td>
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
