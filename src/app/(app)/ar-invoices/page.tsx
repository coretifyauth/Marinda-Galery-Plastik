"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { Customer } from "@/lib/customers/schema";
import { createArInvoiceSchema, invoiceStatus, type ArInvoice } from "@/lib/ar-invoices/schema";
import {
  createArCreditNoteSchema,
  type GoodsIssueForInvoice,
} from "@/lib/ar-credit-notes/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type ReturnLineInput = { item_id: string; name: string; uom: string; qty_available: number; qty_returned: string };

const statusStyle: Record<string, string> = {
  lunas: "bg-emerald-50 text-emerald-700",
  sebagian: "bg-amber-50 text-amber-700",
  belum: "bg-slate-100 text-slate-600",
  dibatalkan: "bg-slate-100 text-slate-400 line-through",
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
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const [returInvoice, setReturInvoice] = useState<ArInvoice | null>(null);
  const [returGoodsIssue, setReturGoodsIssue] = useState<GoodsIssueForInvoice | null>(null);
  const [returChecking, setReturChecking] = useState(false);
  const [returDate, setReturDate] = useState("");
  const [returSourceRef, setReturSourceRef] = useState("");
  const [returAmount, setReturAmount] = useState("");
  const [returContraAccountId, setReturContraAccountId] = useState("");
  const [returReceivableAccountId, setReturReceivableAccountId] = useState("");
  const [returHppAccountId, setReturHppAccountId] = useState("");
  const [returFinishedGoodAccountId, setReturFinishedGoodAccountId] = useState("");
  const [returLines, setReturLines] = useState<ReturnLineInput[]>([]);
  const [returError, setReturError] = useState<string | null>(null);
  const [returSubmitting, setReturSubmitting] = useState(false);

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
        "id, customer_id, invoice_date, due_date, description, source_ref, amount, journal_entry_id, created_at, customers(name), ar_payment_allocations(amount), ar_credit_notes(amount)"
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

  async function handleCancel(invoice: ArInvoice) {
    const sourceRef = window.prompt(
      `Batalkan invoice ${invoice.source_ref} (Rp${invoice.amount.toLocaleString("id-ID")})?\nMasukin rujukan dokumen buat entry pembalik:`,
      `Pembatalan ${invoice.source_ref}`
    );
    if (!sourceRef) return;

    setCancelError(null);
    setCancellingId(invoice.id);
    const { error } = await supabase.rpc("cancel_ar_invoice", {
      p_invoice_id: invoice.id,
      p_entry_date: new Date().toISOString().slice(0, 10),
      p_source_ref: sourceRef,
    });
    setCancellingId(null);
    if (error) {
      setCancelError(error.message);
      return;
    }
    await Promise.all([loadInvoices(), loadReversedEntryIds()]);
  }

  async function openRetur(invoice: ArInvoice) {
    setReturError(null);
    setReturInvoice(invoice);
    setReturDate("");
    setReturSourceRef("");
    setReturAmount("");
    setReturContraAccountId("");
    setReturReceivableAccountId("");
    setReturHppAccountId("");
    setReturFinishedGoodAccountId("");
    setReturGoodsIssue(null);
    setReturLines([]);
    setReturChecking(true);

    const { data } = await supabase
      .from("goods_issues")
      .select("id, goods_issue_lines(item_id, qty_issued, items(name, uom))")
      .eq("invoice_id", invoice.id)
      .maybeSingle();

    const gi = (data ?? null) as unknown as GoodsIssueForInvoice | null;
    setReturGoodsIssue(gi);
    setReturChecking(false);
    if (gi) {
      setReturLines(
        gi.goods_issue_lines.map((l) => ({
          item_id: l.item_id,
          name: l.items.name,
          uom: l.items.uom,
          qty_available: l.qty_issued,
          qty_returned: "",
        }))
      );
    }
  }

  function updateReturLine(itemId: string, qty: string) {
    setReturLines((prev) => prev.map((l) => (l.item_id === itemId ? { ...l, qty_returned: qty } : l)));
  }

  async function handleReturSubmit(e: FormEvent) {
    e.preventDefault();
    if (!returInvoice) return;
    setReturError(null);

    const activeLines = returLines
      .filter((l) => l.qty_returned.trim() !== "")
      .map((l) => ({ item_id: l.item_id, qty_returned: l.qty_returned }));

    const parsed = createArCreditNoteSchema.safeParse({
      invoice_id: returInvoice.id,
      credit_note_date: returDate,
      source_ref: returSourceRef,
      amount: returAmount,
      contra_revenue_account_id: returContraAccountId,
      receivable_account_id: returReceivableAccountId,
      lines: activeLines,
      hpp_account_id: returHppAccountId || undefined,
      finished_good_account_id: returFinishedGoodAccountId || undefined,
    });
    if (!parsed.success) {
      setReturError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    if (returGoodsIssue && activeLines.length === 0) {
      setReturError("Invoice ini lewat goods issue — isi minimal 1 baris qty retur");
      return;
    }

    setReturSubmitting(true);
    const { error } = await supabase.rpc("create_ar_credit_note", {
      p_invoice_id: parsed.data.invoice_id,
      p_credit_note_date: parsed.data.credit_note_date,
      p_source_ref: parsed.data.source_ref,
      p_amount: parsed.data.amount,
      p_contra_revenue_account_id: parsed.data.contra_revenue_account_id,
      p_receivable_account_id: parsed.data.receivable_account_id,
      p_lines: parsed.data.lines.length > 0 ? parsed.data.lines : null,
      p_hpp_account_id: parsed.data.hpp_account_id ?? null,
      p_finished_good_account_id: parsed.data.finished_good_account_id ?? null,
    });
    setReturSubmitting(false);
    if (error) {
      setReturError(error.message);
      return;
    }

    setReturInvoice(null);
    await loadInvoices();
  }

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
      {cancelError && <FormError>{cancelError}</FormError>}

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
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => {
              const isCancelled = reversedEntryIds.has(inv.journal_entry_id);
              const { status, outstanding, allocated, returned } = invoiceStatus(inv, isCancelled);
              const overdue =
                status !== "lunas" && status !== "dibatalkan" && inv.due_date < new Date().toISOString().slice(0, 10);
              const canCancel = canWrite && !isCancelled && allocated === 0;
              // Retur boleh jalan walau invoice udah lunas (outstanding 0/negatif) — DB trigger
              // yang jaga no-over-return terhadap invoice.amount, bukan terhadap outstanding.
              const canRetur = canWrite && !isCancelled;
              return (
                <tr key={inv.id} className="border-b border-slate-100 hover:bg-slate-50">
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
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-3">
                      {canRetur && (
                        <button
                          type="button"
                          onClick={() => openRetur(inv)}
                          className="text-xs text-amber-600 hover:underline"
                        >
                          Retur
                        </button>
                      )}
                      {canCancel && (
                        <button
                          type="button"
                          onClick={() => handleCancel(inv)}
                          disabled={cancellingId === inv.id}
                          className="text-xs text-red-600 hover:underline disabled:opacity-40"
                        >
                          {cancellingId === inv.id ? "Membatalkan..." : "Batalkan"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-400">
                  Belum ada invoice.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {returInvoice && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-black">
              Retur — {returInvoice.customers.name} ({returInvoice.source_ref})
            </h2>
            <button
              type="button"
              onClick={() => setReturInvoice(null)}
              className="text-xs text-slate-500 hover:underline"
            >
              Batal
            </button>
          </div>
          {returChecking ? (
            <p className="mb-4 text-sm text-slate-500">Mengecek jalur retur...</p>
          ) : (
            <p className="mb-4 text-sm text-slate-600">
              {returGoodsIssue
                ? "Invoice ini lewat Goods Issue — isi qty per item yang balik, stok & HPP otomatis ke-reverse proporsional."
                : "Invoice ini gak lewat Goods Issue — retur cuma ngurangin piutang (kontra-revenue), gak ada stok yang disentuh."}
            </p>
          )}
          <form onSubmit={handleReturSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_date">Tanggal Retur</Label>
                <Input id="retur_date" type="date" value={returDate} onChange={(e) => setReturDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_source_ref">Rujukan dokumen</Label>
                <Input
                  id="retur_source_ref"
                  placeholder="mis. Nota retur #001"
                  value={returSourceRef}
                  onChange={(e) => setReturSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_amount">Nominal Retur (kurangin piutang)</Label>
                <Input
                  id="retur_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={returAmount}
                  onChange={(e) => setReturAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_contra_account">Akun Retur & Potongan Penjualan (debit)</Label>
                <Select
                  id="retur_contra_account"
                  value={returContraAccountId}
                  onChange={(e) => setReturContraAccountId(e.target.value)}
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
                <Label htmlFor="retur_receivable_account">Akun Piutang Usaha (kredit)</Label>
                <Select
                  id="retur_receivable_account"
                  value={returReceivableAccountId}
                  onChange={(e) => setReturReceivableAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              {returGoodsIssue && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="retur_hpp_account">Akun HPP (kredit, jurnal reversal)</Label>
                    <Select
                      id="retur_hpp_account"
                      value={returHppAccountId}
                      onChange={(e) => setReturHppAccountId(e.target.value)}
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
                    <Label htmlFor="retur_finished_good_account">Akun Persediaan Barang Jadi (debit)</Label>
                    <Select
                      id="retur_finished_good_account"
                      value={returFinishedGoodAccountId}
                      onChange={(e) => setReturFinishedGoodAccountId(e.target.value)}
                    >
                      <option value="">Pilih akun...</option>
                      {leafAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </>
              )}
            </div>

            {returGoodsIssue && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_8rem] gap-2 text-sm font-medium text-slate-500">
                  <span>Item Terjual (qty asli)</span>
                  <span>Qty Retur</span>
                </div>
                {returLines.map((line) => (
                  <div key={line.item_id} className="grid grid-cols-[1fr_8rem] gap-2">
                    <span className="flex items-center text-sm text-slate-700">
                      {line.name} ({line.qty_available} {line.uom})
                    </span>
                    <Input
                      type="number"
                      min="0"
                      placeholder="0"
                      value={line.qty_returned}
                      onChange={(e) => updateReturLine(line.item_id, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            )}

            {returError && <FormError>{returError}</FormError>}

            <Button type="submit" disabled={returSubmitting} className="w-fit">
              {returSubmitting ? "Menyimpan..." : "Simpan Retur"}
            </Button>
          </form>
        </div>
      )}

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
