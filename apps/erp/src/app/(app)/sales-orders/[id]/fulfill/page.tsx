"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { lineRemaining, type SalesOrder } from "@/lib/sales-orders/schema";
import { createGoodsIssueSchema } from "@/lib/goods-issues/schema";
import { fetchTaxSettings, resolvedPpnKeluaran, type TaxSettings } from "@/lib/tax-settings/schema";
import {
  resolveChargeLines,
  resolveChargeLineLegs,
  type ChargeLineInput,
  type ChargeCategoryWithAccount,
} from "@/lib/charge-lines/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { ChargeLinesEditor } from "@/components/ui/charge-lines-editor";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

type FulfillLineInput = { order_line_id: string; item_id: string; item_label: string; qty_issued: string; unit_price: number };

export default function FulfillSalesOrderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [so, setSo] = useState<SalesOrder | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [invoiceDate, setInvoiceDate] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [fulfillLines, setFulfillLines] = useState<FulfillLineInput[]>([]);
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ChargeCategoryWithAccount[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: soData, error: soErr } = await supabase
      .from("orders")
      .select(
        "id, counterparty_id, order_date, expected_date, source_ref, created_at, cancelled_at, counterparties(name), order_lines(id, item_id, qty_ordered, unit_price, items(name, uom), goods_note_lines(qty))"
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
    setFulfillLines(
      typedSo.order_lines
        .filter((l) => lineRemaining(l) > 0)
        .map((l) => ({
          order_line_id: l.id,
          item_id: l.item_id,
          item_label: `${l.items.name} (sisa ${lineRemaining(l)} ${l.items.uom})`,
          qty_issued: String(lineRemaining(l)),
          unit_price: l.unit_price,
        }))
    );
    setLoadError(null);
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await Promise.all([
        load(),
        fetchDefaultAccounts().then(setDefaultAccounts),
        supabase
          .from("charge_categories")
          .select("id, name, account_id, archived_at, accounts(code, name)")
          .eq("module", "ar")
          .order("name")
          .then(({ data }) => setChargeTypes((data ?? []) as unknown as ChargeCategoryWithAccount[])),
        fetchTaxSettings().then(setTaxSettings),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

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

    router.push(`/sales-orders/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!so) {
    return <FormError>{loadError ?? "Sales order gak ditemukan."}</FormError>;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/sales-orders/${id}`} label="Kembali ke Detail Sales Order" />

      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Kirim & Penuhi Sales Order</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {so.source_ref}
          </span>
        </div>
        <p className="text-sm text-slate-500">
          Pelanggan: {so.counterparties.name}. Tiap kali dikirim, invoice baru terbit senilai qty yang
          dikirim sekarang — bukan nunggu sales order ini terpenuhi penuh (ref: `docs/domain/inventory.md`
          submodul &quot;Sales Order &amp; Pemenuhan Bertahap&quot;).
        </p>
      </div>

      <form onSubmit={handleFulfill} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                htmlFor="receivable_account"
                resolved={defaultAccounts["ar.receivable"]}
              />
              <LockedAccountField htmlFor="revenue_account" resolved={defaultAccounts["ar.revenue"]} />
              <LockedAccountField htmlFor="hpp_account" resolved={defaultAccounts["inventory.hpp"]} />
              <LockedAccountField
                htmlFor="finished_good_account"
                resolved={defaultAccounts["inventory.finished_good"]}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Item yang Dikirim</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_10rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item (sisa SO)</span>
                <span>Qty Kirim</span>
              </div>
              {fulfillLines.length === 0 && (
                <p className="text-sm text-slate-400">Sales order ini sudah terkirim penuh.</p>
              )}
              {fulfillLines.map((line, i) => (
                <div key={line.order_line_id} className="grid grid-cols-[1fr_10rem] gap-2">
                  <span className="flex items-center text-sm text-slate-700">{line.item_label}</span>
                  <Input
                    type="number"
                    min="0"
                    value={line.qty_issued}
                    onChange={(e) => updateFulfillQty(i, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <ChargeLinesEditor
              label="Kategori Pendapatan Tambahan (opsional — mis. jasa antar)"
              lines={extraLines}
              chargeTypes={chargeTypes}
              onChange={setExtraLines}
            />

            {taxSettings?.is_active && (
              <label className="mt-4 flex w-fit items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={applyTax}
                  onChange={(e) => setApplyTax(e.target.checked)}
                />
                Kena PPN Keluaran ({taxSettings.ppn_rate}%, dihitung otomatis dari subtotal)
              </label>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
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
                { label: "Akun HPP (debit, jurnal kedua)", resolved: defaultAccounts["inventory.hpp"], side: "debit" },
                {
                  label: "Akun Persediaan Barang Jadi (kredit, jurnal kedua)",
                  resolved: defaultAccounts["inventory.finished_good"],
                  side: "credit",
                },
              ],
            ]}
          />

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">Nilai Invoice</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{fulfillAmount.toLocaleString("id-ID")}</p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menyimpan..." : "Kirim & Terbitkan Invoice"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Batal
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
