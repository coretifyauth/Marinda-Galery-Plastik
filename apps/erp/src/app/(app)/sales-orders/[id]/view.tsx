"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { soStatus, lineRemaining, type SalesOrder } from "@/lib/sales-orders/schema";
import { createGoodsIssueSchema } from "@/lib/goods-issues/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

type FulfillmentRow = {
  id: string;
  item_id: string;
  qty_issued: number;
  total_cost: number;
  so_line_id: string | null;
  items: { name: string; uom: string };
  goods_issues: { id: string; issue_date: string; ar_invoices: { source_ref: string; amount: number } };
};

type FulfillLineInput = { so_line_id: string; item_id: string; item_label: string; qty_issued: string; unit_price: number };

const statusStyle: Record<string, string> = {
  OPEN: "bg-slate-100 text-slate-600",
  PARTIALLY_FULFILLED: "bg-amber-50 text-amber-700",
  FULLY_FULFILLED: "bg-emerald-50 text-emerald-700",
};

export function SalesOrderDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [so, setSo] = useState<SalesOrder | null>(null);
  const [fulfillments, setFulfillments] = useState<FulfillmentRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showFulfillForm, setShowFulfillForm] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState("");
  const [description, setDescription] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [receivableAccountId, setReceivableAccountId] = useState("");
  const [revenueAccountId, setRevenueAccountId] = useState("");
  const [hppAccountId, setHppAccountId] = useState("");
  const [finishedGoodAccountId, setFinishedGoodAccountId] = useState("");
  const [fulfillLines, setFulfillLines] = useState<FulfillLineInput[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const { data: soData, error: soErr } = await supabase
      .from("sales_orders")
      .select(
        "id, customer_id, so_date, expected_date, source_ref, created_at, customers(name), sales_order_lines(id, item_id, qty_ordered, unit_price, items(name, uom), goods_issue_lines(qty_issued))"
      )
      .eq("id", id)
      .single();
    if (soErr || !soData) {
      setLoadError(soErr?.message ?? "Sales order gak ditemukan.");
      return;
    }
    const typedSo = soData as unknown as SalesOrder;
    setSo(typedSo);

    const soLineIds = typedSo.sales_order_lines.map((l) => l.id);
    if (soLineIds.length > 0) {
      const { data: fulfillData } = await supabase
        .from("goods_issue_lines")
        .select(
          "id, item_id, qty_issued, total_cost, so_line_id, items(name, uom), goods_issues(id, issue_date, ar_invoices(source_ref, amount))"
        )
        .in("so_line_id", soLineIds)
        .order("id");
      setFulfillments((fulfillData ?? []) as unknown as FulfillmentRow[]);
    }
    setLoadError(null);
  }, [id]);

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
      await Promise.all([load(), loadAccounts()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load, loadAccounts]);

  function openFulfillForm() {
    if (!so) return;
    setFulfillLines(
      so.sales_order_lines
        .filter((l) => lineRemaining(l) > 0)
        .map((l) => ({
          so_line_id: l.id,
          item_id: l.item_id,
          item_label: `${l.items.name} (sisa ${lineRemaining(l)} ${l.items.uom})`,
          qty_issued: String(lineRemaining(l)),
          unit_price: l.unit_price,
        }))
    );
    setShowFulfillForm(true);
  }

  function updateFulfillQty(index: number, qty: string) {
    setFulfillLines((prev) => prev.map((l, i) => (i === index ? { ...l, qty_issued: qty } : l)));
  }

  const fulfillAmount = fulfillLines.reduce((sum, l) => {
    const qty = Number(l.qty_issued);
    return Number.isNaN(qty) ? sum : sum + qty * l.unit_price;
  }, 0);

  async function handleFulfill(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!so) return;

    const activeLines = fulfillLines.filter((l) => parseFloat(l.qty_issued) > 0);

    const parsed = createGoodsIssueSchema.safeParse({
      customer_id: so.customer_id,
      invoice_date: invoiceDate,
      description,
      source_ref: sourceRef,
      amount: fulfillAmount,
      receivable_account_id: receivableAccountId,
      revenue_account_id: revenueAccountId,
      hpp_account_id: hppAccountId,
      finished_good_account_id: finishedGoodAccountId,
      lines: activeLines.map((l) => ({
        item_id: l.item_id,
        qty_issued: l.qty_issued,
        so_line_id: l.so_line_id,
      })),
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

    setInvoiceDate("");
    setDescription("");
    setSourceRef("");
    setReceivableAccountId("");
    setRevenueAccountId("");
    setHppAccountId("");
    setFinishedGoodAccountId("");
    setFulfillLines([]);
    setShowFulfillForm(false);
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!so) {
    return <FormError>{loadError ?? "Sales order gak ditemukan."}</FormError>;
  }

  const status = soStatus(so);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canFulfill = canWrite && status !== "FULLY_FULFILLED";

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/sales-orders" label="Kembali ke Sales Orders" />
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-black">
              {so.customers.name} — {so.source_ref}
            </h1>
            <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[status]}`}>{status}</span>
          </div>
          <p className="text-sm text-slate-500">{so.so_date}</p>
        </div>
        {canFulfill && (
          <Button variant="toolbar-primary" onClick={() => (showFulfillForm ? setShowFulfillForm(false) : openFulfillForm())}>
            {showFulfillForm ? "Batal" : "Kirim / Penuhi"}
          </Button>
        )}
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-slate-400">Tanggal Pesan</dt>
            <dd className="text-black">{so.so_date}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Butuh Tanggal</dt>
            <dd className="text-black">{so.expected_date ?? "-"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Rujukan Dokumen</dt>
            <dd className="text-black">{so.source_ref}</dd>
          </div>
        </dl>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Item Dipesan</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {so.sales_order_lines.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2 text-right">Qty Pesan</th>
              <th className="px-4 py-2 text-right">Qty Terkirim</th>
              <th className="px-4 py-2 text-right">Harga/Unit</th>
            </tr>
          </thead>
          <tbody>
            {so.sales_order_lines.map((l) => {
              const issued = l.goods_issue_lines.reduce((sum, r) => sum + r.qty_issued, 0);
              return (
                <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-black">
                    {l.items.name} ({l.items.uom})
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{l.qty_ordered}</td>
                  <td className="px-4 py-2 text-right font-mono">{issued}</td>
                  <td className="px-4 py-2 text-right font-mono">{l.unit_price.toLocaleString("id-ID")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Pengiriman (Goods Issue + Invoice)</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {fulfillments.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Invoice</th>
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2 text-right">Qty Dikirim</th>
            </tr>
          </thead>
          <tbody>
            {fulfillments.map((f) => (
              <tr
                key={f.id}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                onClick={() => router.push(`/goods-issues/${f.goods_issues.id}`)}
              >
                <td className="px-4 py-2 text-blue-600">{f.goods_issues.issue_date}</td>
                <td className="px-4 py-2">{f.goods_issues.ar_invoices.source_ref}</td>
                <td className="px-4 py-2">
                  {f.items.name} ({f.items.uom})
                </td>
                <td className="px-4 py-2 text-right font-mono">{f.qty_issued}</td>
              </tr>
            ))}
            {fulfillments.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada pengiriman.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showFulfillForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Kirim Barang (bisa sebagian)</h2>
          <p className="mb-4 text-sm text-slate-500">
            Tiap kali dikirim, invoice baru terbit senilai qty yang dikirim SEKARANG — bukan
            nunggu sales order ini terpenuhi penuh (ref: `docs/domain/inventory.md` submodule
            &quot;Sales Order &amp; Pemenuhan Bertahap&quot;).
          </p>
          <form onSubmit={handleFulfill} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invoice_date">Tanggal Kirim/Invoice</Label>
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
                  placeholder="mis. Nota kirim tahap 1"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="description">Deskripsi</Label>
                <Input
                  id="description"
                  placeholder="mis. Kirim tahap 1 dari SO ini"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
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
                <Select id="revenue_account" value={revenueAccountId} onChange={(e) => setRevenueAccountId(e.target.value)}>
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
              <div className="grid grid-cols-[1fr_8rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item (sisa SO)</span>
                <span>Qty Kirim</span>
              </div>
              {fulfillLines.length === 0 && (
                <p className="text-sm text-slate-400">Sales order ini sudah terkirim penuh.</p>
              )}
              {fulfillLines.map((line, i) => (
                <div key={line.so_line_id} className="grid grid-cols-[1fr_8rem] gap-2">
                  <span className="flex items-center text-sm text-slate-700">{line.item_label}</span>
                  <Input
                    type="number"
                    min="0"
                    value={line.qty_issued}
                    onChange={(e) => updateFulfillQty(i, e.target.value)}
                  />
                </div>
              ))}
              <p className="text-sm text-slate-500">
                Nilai invoice: <span className="font-mono text-black">{fulfillAmount.toLocaleString("id-ID")}</span>
              </p>
            </div>

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Kirim & Terbitkan Invoice"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
