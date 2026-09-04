"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { soStatus, lineRemaining, type SalesOrder } from "@/lib/sales-orders/schema";
import { createGoodsIssueSchema } from "@/lib/goods-issues/schema";
import type { ArInvoiceChargeType } from "@/lib/ar-invoice-charge-types/schema";
import { fetchTaxSettings, resolvedPpnKeluaran, type TaxSettings } from "@/lib/tax-settings/schema";
import { resolveChargeLines, resolveChargeLineLegs, type ChargeLineInput } from "@/lib/charge-lines/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { Modal } from "@/components/ui/modal";
import { DetailRows } from "@/components/ui/detail-rows";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { ChargeLinesEditor } from "@/components/ui/charge-lines-editor";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";

type FulfillmentRow = {
  id: string;
  item_id: string;
  qty_issued: number;
  total_cost: number;
  order_line_id: string | null;
  items: { name: string; uom: string };
  goods_issues: { id: string; invoice_id: string; issue_date: string; ar_invoices: { source_ref: string; amount: number } };
};

type FulfillLineInput = { order_line_id: string; item_id: string; item_label: string; qty_issued: string; unit_price: number };

const statusStyle: Record<string, string> = {
  OPEN: "bg-slate-100 text-slate-600",
  PARTIALLY_FULFILLED: "bg-amber-50 text-amber-700",
  FULLY_FULFILLED: "bg-emerald-50 text-emerald-700",
  CANCELLED: "bg-slate-100 text-slate-400 line-through",
};

export function SalesOrderDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [so, setSo] = useState<SalesOrder | null>(null);
  const [fulfillments, setFulfillments] = useState<FulfillmentRow[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [activeTab, setActiveTab] = useState("lines");

  const [showFulfillForm, setShowFulfillForm] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [fulfillLines, setFulfillLines] = useState<FulfillLineInput[]>([]);
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ArInvoiceChargeType[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: soData, error: soErr } = await supabase
      .from("orders")
      .select(
        "id, counterparty_id, order_date, expected_date, source_ref, created_at, cancelled_at, counterparties(name), order_lines(id, item_id, qty_ordered, unit_price, items(name, uom), goods_issue_lines(qty_issued))"
      )
      .eq("id", id)
      .eq("direction", "SALE")
      .single();
    if (soErr || !soData) {
      setLoadError(soErr?.message ?? "Sales order gak ditemukan.");
      return;
    }
    const typedSo = soData as unknown as SalesOrder;
    setSo(typedSo);

    const orderLineIds = typedSo.order_lines.map((l) => l.id);
    if (orderLineIds.length > 0) {
      const { data: fulfillData } = await supabase
        .from("goods_issue_lines")
        .select(
          "id, item_id, qty_issued, total_cost, order_line_id, items(name, uom), goods_issues(id, invoice_id, issue_date, ar_invoices(source_ref, amount))"
        )
        .in("order_line_id", orderLineIds)
        .order("id");
      setFulfillments((fulfillData ?? []) as unknown as FulfillmentRow[]);
    }
    setLoadError(null);
  }, [id]);

  const loadDefaultAccounts = useCallback(async () => {
    setDefaultAccounts(await fetchDefaultAccounts());
  }, []);

  const loadChargeTypes = useCallback(async () => {
    const { data } = await supabase
      .from("ar_invoice_charge_types")
      .select("id, name, account_id, archived_at, accounts(code, name)")
      .order("name");
    setChargeTypes((data ?? []) as unknown as ArInvoiceChargeType[]);
  }, []);

  const loadTaxSettings = useCallback(async () => {
    setTaxSettings(await fetchTaxSettings());
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
      await Promise.all([load(), loadDefaultAccounts(), loadChargeTypes(), loadTaxSettings()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load, loadDefaultAccounts, loadChargeTypes, loadTaxSettings]);

  function openFulfillForm() {
    if (!so) return;
    setFulfillLines(
      so.order_lines
        .filter((l) => lineRemaining(l) > 0)
        .map((l) => ({
          order_line_id: l.id,
          item_id: l.item_id,
          item_label: `${l.items.name} (sisa ${lineRemaining(l)} ${l.items.uom})`,
          qty_issued: String(lineRemaining(l)),
          unit_price: l.unit_price,
        }))
    );
    setExtraLines([]);
    setApplyTax(false);
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

    const creditLines = [
      { account_id: defaultAccounts["ar.revenue"]?.id ?? "", amount: fulfillAmount },
      ...resolveChargeLines(extraLines, chargeTypes),
    ];

    const parsed = createGoodsIssueSchema.safeParse({
      customer_id: so.counterparty_id,
      invoice_date: invoiceDate,
      description,
      credit_lines: creditLines,
      receivable_account_id: defaultAccounts["ar.receivable"]?.id ?? "",
      hpp_account_id: defaultAccounts["inventory.hpp"]?.id ?? "",
      finished_good_account_id: defaultAccounts["inventory.finished_good"]?.id ?? "",
      lines: activeLines.map((l) => ({
        item_id: l.item_id,
        qty_issued: l.qty_issued,
        order_line_id: l.order_line_id,
      })),
      apply_tax: applyTax,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ar_invoices");
    } catch (err) {
      setSubmitting(false);
      setFormError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_goods_issue", {
      p_customer_id: parsed.data.customer_id,
      p_invoice_date: parsed.data.invoice_date,
      p_description: parsed.data.description || null,
      p_source_ref: sourceRef,
      p_credit_lines: parsed.data.credit_lines,
      p_receivable_account_id: parsed.data.receivable_account_id,
      p_lines: parsed.data.lines,
      p_hpp_account_id: parsed.data.hpp_account_id,
      p_finished_good_account_id: parsed.data.finished_good_account_id,
      p_apply_tax: parsed.data.apply_tax,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setInvoiceDate("");
    setDescription("");
    setFulfillLines([]);
    setExtraLines([]);
    setApplyTax(false);
    setShowFulfillForm(false);
    await load();
  }

  async function handleCancel() {
    if (!so) return;
    if (!window.confirm(`Batalkan sales order ${so.source_ref}?`)) return;

    setCancelError(null);
    setCancelling(true);
    const { error } = await supabase.rpc("cancel_order", {
      p_order_id: so.id,
    });
    setCancelling(false);
    if (error) {
      setCancelError(error.message);
      return;
    }
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
  const canFulfill = canWrite && status !== "FULLY_FULFILLED" && status !== "CANCELLED";
  const canCancel = canWrite && status === "OPEN";

  const detailGroups = [
    {
      title: "Informasi Sales Order",
      rows: [
        { label: "Customer", value: so.counterparties.name },
        { label: "Rujukan Dokumen", value: so.source_ref },
        { label: "Tanggal Pesan", value: so.order_date },
        { label: "Butuh Tanggal", value: so.expected_date ?? "-" },
        {
          label: "Status",
          value: <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[status]}`}>{status}</span>,
        },
      ],
    },
  ];

  const tabs: TabDef[] = [
    { key: "lines", label: "Item Dipesan", badge: so.order_lines.length },
    { key: "fulfillments", label: "Pengiriman (Goods Issue + Invoice)", badge: fulfillments.length },
  ];

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/sales-orders" label="Kembali ke Sales Orders" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Sales Order Details</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {so.source_ref}
          </span>
        </div>
        {canCancel && (
          <Button variant="toolbar" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? "Membatalkan..." : "Batalkan SO"}
          </Button>
        )}
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {cancelError && <FormError>{cancelError}</FormError>}

      <DetailRows groups={detailGroups} />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === "lines" && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
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
              {so.order_lines.map((l) => {
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
      )}

      {activeTab === "fulfillments" && (
        <div className="flex flex-col gap-3">
          {canFulfill && (
            <div className="flex justify-end">
              <Button variant="toolbar-primary" onClick={openFulfillForm}>
                Kirim / Penuhi
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
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
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        className="text-blue-600 hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/ar-invoices/${f.goods_issues.invoice_id}`);
                        }}
                      >
                        {f.goods_issues.ar_invoices.source_ref}
                      </button>
                    </td>
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
        </div>
      )}

      <Modal
        open={showFulfillForm}
        onClose={() => setShowFulfillForm(false)}
        title="Kirim Barang (bisa sebagian)"
        maxWidth="max-w-3xl"
      >
        <p className="mb-4 text-sm text-slate-500">
          Tiap kali dikirim, invoice baru terbit senilai qty yang dikirim SEKARANG — bukan
          nunggu sales order ini terpenuhi penuh (ref: `docs/domain/inventory.md` submodule
          &quot;Sales Order &amp; Pemenuhan Bertahap&quot;).
        </p>
        <JournalPreviewPanel
          groups={[
            [
              { label: "Akun Piutang Usaha (debit)", resolved: defaultAccounts["ar.receivable"], side: "debit" },
              { label: "Akun Pendapatan (kredit)", resolved: defaultAccounts["ar.revenue"], side: "credit" },
              ...resolveChargeLineLegs(extraLines, chargeTypes, "credit"),
              applyTax && {
                label: "Akun PPN Keluaran (kredit)",
                resolved: resolvedPpnKeluaran(taxSettings),
                side: "credit",
              },
            ],
            [
              {
                label: "Akun HPP (debit, jurnal kedua)",
                resolved: defaultAccounts["inventory.hpp"],
                side: "debit",
              },
              {
                label: "Akun Persediaan Barang Jadi (kredit, jurnal kedua)",
                resolved: defaultAccounts["inventory.finished_good"],
                side: "credit",
              },
            ],
          ]}
        />
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
                <Label htmlFor="description">Deskripsi</Label>
                <Input
                  id="description"
                  placeholder="mis. Kirim tahap 1 dari SO ini"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Piutang Usaha (debit)"
                htmlFor="receivable_account"
                resolved={defaultAccounts["ar.receivable"]}
              />
              <LockedAccountField
                label="Akun Pendapatan (kredit)"
                htmlFor="revenue_account"
                resolved={defaultAccounts["ar.revenue"]}
              />
              <LockedAccountField
                label="Akun HPP (debit, jurnal kedua)"
                htmlFor="hpp_account"
                resolved={defaultAccounts["inventory.hpp"]}
              />
              <LockedAccountField
                label="Akun Persediaan Barang Jadi (kredit, jurnal kedua)"
                htmlFor="finished_good_account"
                resolved={defaultAccounts["inventory.finished_good"]}
              />
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
                <div key={line.order_line_id} className="grid grid-cols-[1fr_8rem] gap-2">
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

            <ChargeLinesEditor
              label="Kategori Pendapatan Tambahan (opsional — mis. jasa antar)"
              lines={extraLines}
              chargeTypes={chargeTypes}
              onChange={setExtraLines}
            />

            {taxSettings?.is_active && (
              <label className="flex w-fit items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={applyTax}
                  onChange={(e) => setApplyTax(e.target.checked)}
                />
                Kena PPN Keluaran ({taxSettings.ppn_rate}%, dihitung otomatis dari subtotal)
              </label>
            )}

            {formError && <FormError>{formError}</FormError>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowFulfillForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Menyimpan..." : "Kirim & Terbitkan Invoice"}
              </Button>
            </div>
        </form>
      </Modal>
    </div>
  );
}
