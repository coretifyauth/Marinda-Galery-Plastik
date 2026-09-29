"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { fetchWalkInCustomerId } from "@/lib/pos-settings/schema";
import type { Customer } from "@/lib/customers/schema";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createGoodsIssueSchema } from "@/lib/goods-issues/schema";
import { UomPriceQtyInput, type UomQtyChange } from "@/components/ui/uom-price-qty-input";
import {
  fetchActiveItemDiscountRules,
  resolveItemDiscount,
  type ItemDiscountRule,
} from "@/lib/item-discount-rules/schema";
import {
  fetchActiveBundlePromoRules,
  resolveBundlePromoDiscounts,
  type BundlePromoRule,
} from "@/lib/bundle-promo-rules/schema";
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
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { ChargeLinesEditor } from "@/components/ui/charge-lines-editor";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

type LineInput = {
  item_id: string;
  qty: string;
  amount: number;
  baseQty: number;
  discountRuleId: string | null;
  discountAmount: number;
};

function emptyLine(): LineInput {
  return { item_id: "", qty: "", amount: 0, baseQty: 0, discountRuleId: null, discountAmount: 0 };
}

export default function NewGoodsIssuePage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [discountRules, setDiscountRules] = useState<ItemDiscountRule[]>([]);
  const [bundleRules, setBundleRules] = useState<BundlePromoRule[]>([]);

  const [customerId, setCustomerId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ChargeCategoryWithAccount[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadCustomers = useCallback(async () => {
    const walkInCustomerId = await fetchWalkInCustomerId();
    let query = supabase
      .from("counterparties")
      .select("id, name, contact, payment_term_days, archived_at, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "customer")
      .order("name");
    if (walkInCustomerId) query = query.neq("id", walkInCustomerId);
    const { data } = await query;
    setCustomers((data ?? []) as unknown as Customer[]);
  }, []);

  const loadItems = useCallback(async () => {
    const [{ data }, { data: units }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, category_id, archived_at")
        .order("name"),
      supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
    ]);
    setItems((data ?? []) as Item[]);
    setItemUnits((units ?? []) as ItemUnit[]);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await Promise.all([
        loadCustomers(),
        loadItems(),
        fetchDefaultAccounts().then(setDefaultAccounts),
        supabase
          .from("charge_categories")
          .select("id, name, account_id, archived_at, accounts(code, name)")
          .eq("module", "ar")
          .order("name")
          .then(({ data }) => setChargeTypes((data ?? []) as unknown as ChargeCategoryWithAccount[])),
        fetchTaxSettings().then(setTaxSettings),
        fetchActiveItemDiscountRules().then(setDiscountRules),
        fetchActiveBundlePromoRules().then(setBundleRules),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadItems]);

  function updateLineItem(index: number, itemId: string) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...emptyLine(), item_id: itemId } : l)));
  }

  function updateLineQty(index: number, itemId: string, change: UomQtyChange | null) {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== index) return l;
        if (!change) return { ...l, qty: "", amount: 0, baseQty: 0, discountRuleId: null, discountAmount: 0 };
        const item = items.find((it) => it.id === itemId);
        const resolved = resolveItemDiscount(itemId, item?.category_id ?? null, change.baseQty, change.amount, discountRules);
        return {
          ...l,
          qty: String(change.baseQty),
          amount: change.amount,
          baseQty: change.baseQty,
          discountRuleId: resolved?.discount_rule_id ?? null,
          discountAmount: resolved?.discount_amount ?? 0,
        };
      })
    );
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  // Bundle promo (Beli N Gratis X) butuh lihat SEMUA baris sekaligus (qty pemicu lintas baris)
  // -- dihitung derived tiap render, DIGABUNG ke discountAmount per-item yang udah ada
  // (dibatasi gak lebih dari amount baris itu sendiri), bukan disimpan terpisah di state.
  const bundleResolved = resolveBundlePromoDiscounts(
    lines.map((l) => ({ item_id: l.item_id, qty: l.baseQty, unit_price: l.baseQty > 0 ? l.amount / l.baseQty : 0 })),
    bundleRules
  );
  const linesWithBundle = lines.map((l, i) => {
    const bundle = bundleResolved.get(i);
    const combinedDiscount = Math.min(l.discountAmount + (bundle?.discount_amount ?? 0), l.amount);
    return { ...l, bundlePromoRuleId: bundle?.bundle_promo_rule_id ?? null, combinedDiscount };
  });

  const grossAmount = lines.reduce((sum, l) => sum + l.amount, 0);
  const totalDiscount = linesWithBundle.reduce((sum, l) => sum + l.combinedDiscount, 0);
  const totalAmount = grossAmount - totalDiscount;

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const activeLines = linesWithBundle.filter((l) => l.item_id.trim() !== "" && l.qty.trim() !== "");
    const convertedLines = activeLines.map((l) => ({
      item_id: l.item_id,
      qty_issued: Number(l.qty),
      discount_rule_id: l.discountRuleId ?? undefined,
      discount_amount: l.combinedDiscount,
      bundle_promo_rule_id: l.bundlePromoRuleId ?? undefined,
    }));

    const creditLines = [
      { account_id: defaultAccounts["ar.revenue"]?.id ?? "", amount: totalAmount },
      ...resolveChargeLines(extraLines, chargeTypes),
    ];

    const parsed = createGoodsIssueSchema.safeParse({
      customer_id: customerId,
      invoice_date: invoiceDate,
      description,
      credit_lines: creditLines,
      receivable_account_id: defaultAccounts["ar.receivable"]?.id ?? "",
      hpp_account_id: defaultAccounts["inventory.hpp"]?.id ?? "",
      finished_good_account_id: defaultAccounts["inventory.finished_good"]?.id ?? "",
      lines: convertedLines,
      apply_tax: applyTax,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const sourceRef = await generateDocumentNumber("ar_invoices").catch((err) => {
      setFormError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return null;
    });
    if (!sourceRef) {
      setSubmitting(false);
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
    router.push("/goods-issues");
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const sellableItems = items.filter((item) => itemUnits.some((u) => u.item_id === item.id && u.price != null));

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/goods-issues" label="Kembali ke Barang Keluar" />

      <div>
        <h1 className="text-xl font-semibold text-black">Jual Barang Jadi Langsung</h1>
        <p className="text-sm text-slate-500">
          Invoice + Barang Keluar tanpa Sales Order — buat penjualan spontan/tanpa pesanan sebelumnya. Kalau
          barang ini dipesan lewat Sales Order, kirim/penuhi dari halaman detail SO-nya.
        </p>
      </div>

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customer">Pelanggan</Label>
                <Select id="customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">Pilih pelanggan...</option>
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
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="description">Deskripsi</Label>
                <Input
                  id="description"
                  placeholder="mis. Jual barang ke Toko Kelontong Sumber Rejeki"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <LockedAccountField htmlFor="receivable_account" resolved={defaultAccounts["ar.receivable"]} />
              <LockedAccountField htmlFor="revenue_account" resolved={defaultAccounts["ar.revenue"]} />
              <LockedAccountField htmlFor="hpp_account" resolved={defaultAccounts["inventory.hpp"]} />
              <LockedAccountField
                htmlFor="finished_good_account"
                resolved={defaultAccounts["inventory.finished_good"]}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Barang Jadi Keluar</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(14rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty & Satuan (harga otomatis)</span>
                <span />
              </div>
              {linesWithBundle.map((line, i) => {
                const unitsForItem = itemUnits.filter((u) => u.item_id === line.item_id && u.price != null);
                return (
                  <div key={i} className="grid grid-cols-[1fr_minmax(14rem,auto)_2.5rem] gap-2">
                    <Select value={line.item_id} onChange={(e) => updateLineItem(i, e.target.value)}>
                      <option value="">Pilih item...</option>
                      {sellableItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.uom})
                        </option>
                      ))}
                    </Select>
                    {line.item_id && unitsForItem.length > 0 ? (
                      <div className="flex flex-col gap-0.5">
                        <UomPriceQtyInput
                          key={line.item_id}
                          units={unitsForItem}
                          onChange={(change) => updateLineQty(i, line.item_id, change)}
                        />
                        {line.combinedDiscount > 0 && (
                          <span className="text-xs text-emerald-600">
                            {line.bundlePromoRuleId ? "Beli N Gratis X" : "Diskon otomatis"}: -Rp
                            {line.combinedDiscount.toLocaleString("id-ID")}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="flex items-center text-xs text-slate-400">
                        {line.item_id ? "Barang ini belum punya harga jual" : "Pilih item dulu"}
                      </span>
                    )}
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
                );
              })}
              {sellableItems.length === 0 && (
                <p className="text-xs text-amber-600">
                  Belum ada barang dengan harga jual (item_units). Tambah satuan + harga di halaman Item dulu.
                </p>
              )}
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah item
              </Button>
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
                <input type="checkbox" checked={applyTax} onChange={(e) => setApplyTax(e.target.checked)} />
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
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>Subtotal</span>
              <span className="font-mono">Rp{grossAmount.toLocaleString("id-ID")}</span>
            </div>
            {totalDiscount > 0 && (
              <div className="flex items-center justify-between text-sm text-emerald-600">
                <span>Diskon</span>
                <span className="font-mono">-Rp{totalDiscount.toLocaleString("id-ID")}</span>
              </div>
            )}
            <p className="mt-2 text-sm text-slate-500">Jumlah Pendapatan</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{totalAmount.toLocaleString("id-ID")}</p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menyimpan..." : "Simpan Penjualan"}
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
