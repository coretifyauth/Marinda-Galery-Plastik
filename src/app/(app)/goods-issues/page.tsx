"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { Customer } from "@/lib/customers/schema";
import type { Item } from "@/lib/items/schema";
import { createGoodsIssueSchema, type GoodsIssue } from "@/lib/goods-issues/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type LineInput = { item_id: string; qty_issued: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_issued: "" };
}

export default function GoodsIssuesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [issues, setIssues] = useState<GoodsIssue[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [description, setDescription] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [amount, setAmount] = useState("");
  const [receivableAccountId, setReceivableAccountId] = useState("");
  const [revenueAccountId, setRevenueAccountId] = useState("");
  const [hppAccountId, setHppAccountId] = useState("");
  const [finishedGoodAccountId, setFinishedGoodAccountId] = useState("");
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);
  const finishedGoods = items.filter((i) => i.item_type === "FINISHED_GOOD");

  const loadIssues = useCallback(async () => {
    const { data, error } = await supabase
      .from("goods_issues")
      .select(
        "id, invoice_id, journal_entry_id, issue_date, source_ref, created_at, ar_invoices(source_ref, amount, customers(name)), goods_issue_lines(id, item_id, qty_issued, total_cost, items(name, uom))"
      )
      .order("issue_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setIssues((data ?? []) as unknown as GoodsIssue[]);
  }, []);

  const loadCustomers = useCallback(async () => {
    const { data } = await supabase
      .from("customers")
      .select("id, name, contact, payment_term_days, archived_at")
      .order("name");
    setCustomers((data ?? []) as Customer[]);
  }, []);

  const loadItems = useCallback(async () => {
    const { data } = await supabase
      .from("items")
      .select("id, name, item_type, uom, inventory_account_id, archived_at")
      .order("name");
    setItems((data ?? []) as Item[]);
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
      await Promise.all([loadCustomers(), loadItems(), loadAccounts(), loadIssues()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadItems, loadAccounts, loadIssues]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createGoodsIssueSchema.safeParse({
      customer_id: customerId,
      invoice_date: invoiceDate,
      description,
      source_ref: sourceRef,
      amount,
      receivable_account_id: receivableAccountId,
      revenue_account_id: revenueAccountId,
      hpp_account_id: hppAccountId,
      finished_good_account_id: finishedGoodAccountId,
      lines,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_goods_issue", {
      p_customer_id: parsed.data.customer_id,
      p_invoice_date: parsed.data.invoice_date,
      p_description: parsed.data.description || null,
      p_source_ref: parsed.data.source_ref,
      p_amount: parsed.data.amount,
      p_receivable_account_id: parsed.data.receivable_account_id,
      p_revenue_account_id: parsed.data.revenue_account_id,
      p_lines: parsed.data.lines,
      p_hpp_account_id: parsed.data.hpp_account_id,
      p_finished_good_account_id: parsed.data.finished_good_account_id,
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
    setHppAccountId("");
    setFinishedGoodAccountId("");
    setLines([emptyLine()]);
    setShowForm(false);
    await loadIssues();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Goods Issues — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Goods Issues</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {issues.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadIssues()}>
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
              <th className="px-4 py-2">Invoice</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Items Keluar (HPP)</th>
              <th className="px-4 py-2 text-right">Pendapatan</th>
              <th className="px-4 py-2 text-right">Total HPP</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((gi) => {
              const totalHpp = gi.goods_issue_lines.reduce((sum, l) => sum + l.total_cost, 0);
              return (
                <tr key={gi.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-black">{gi.ar_invoices.customers.name}</td>
                  <td className="px-4 py-2">{gi.ar_invoices.source_ref}</td>
                  <td className="whitespace-nowrap px-4 py-2">{gi.issue_date}</td>
                  <td className="px-4 py-2">
                    <ul className="space-y-0.5">
                      {gi.goods_issue_lines.map((l) => (
                        <li key={l.id}>
                          {l.items.name} — {l.qty_issued} {l.items.uom} = {l.total_cost.toLocaleString("id-ID")}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {gi.ar_invoices.amount.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{totalHpp.toLocaleString("id-ID")}</td>
                </tr>
              );
            })}
            {issues.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada goods issue.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Jual Barang Jadi (Invoice + Goods Issue)</h2>
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
                  placeholder="mis. Nota grosir #006"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="description">Deskripsi</Label>
                <Input
                  id="description"
                  placeholder="mis. Jual roti ke Warung Pak Budi"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="amount">Jumlah Pendapatan</Label>
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="hpp_account">Akun HPP (debit, jurnal kedua)</Label>
                <Select id="hpp_account" value={hppAccountId} onChange={(e) => setHppAccountId(e.target.value)}>
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="finished_good_account">Akun Persediaan Barang Jadi (kredit, jurnal kedua)</Label>
                <Select
                  id="finished_good_account"
                  value={finishedGoodAccountId}
                  onChange={(e) => setFinishedGoodAccountId(e.target.value)}
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

            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_8rem_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Barang Jadi Keluar</span>
                <span>Qty Jual</span>
                <span />
              </div>
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-[1fr_8rem_2.5rem] gap-2">
                  <Select value={line.item_id} onChange={(e) => updateLine(i, { item_id: e.target.value })}>
                    <option value="">Pilih item...</option>
                    {finishedGoods.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.uom})
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={line.qty_issued}
                    onChange={(e) => updateLine(i, { qty_issued: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => removeLine(i)}
                    disabled={lines.length <= 1}
                    className="text-slate-400 hover:text-red-600 disabled:opacity-30"
                    aria-label="Hapus baris"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah item
              </Button>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan Penjualan"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
