"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Customer } from "@/lib/customers/schema";
import type { Item } from "@/lib/items/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { createGoodsIssueSchema, type GoodsIssue } from "@/lib/goods-issues/schema";
import { UomPriceQtyInput, type UomQtyChange } from "@/components/ui/uom-price-qty-input";
import type { ArInvoiceChargeType } from "@/lib/ar-invoice-charge-types/schema";
import { fetchTaxSettings, resolvedPpnKeluaran, type TaxSettings } from "@/lib/tax-settings/schema";
import { resolveChargeLines, resolveChargeLineLegs, type ChargeLineInput } from "@/lib/charge-lines/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { ChargeLinesEditor } from "@/components/ui/charge-lines-editor";
import { Modal } from "@/components/ui/modal";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";

type LineInput = { item_id: string; qty: string; amount: number };

function emptyLine(): LineInput {
  return { item_id: "", qty: "", amount: 0 };
}

export default function GoodsIssuesPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [issues, setIssues] = useState<GoodsIssue[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ArInvoiceChargeType[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

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
    const [{ data }, { data: units }] = await Promise.all([
      supabase
        .from("items")
        .select("id, name, item_type, uom, inventory_account_id, archived_at")
        .order("name"),
      supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
    ]);
    setItems((data ?? []) as Item[]);
    setItemUnits((units ?? []) as ItemUnit[]);
  }, []);

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
      await Promise.all([
        loadCustomers(),
        loadItems(),
        loadDefaultAccounts(),
        loadIssues(),
        loadChargeTypes(),
        loadTaxSettings(),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers, loadItems, loadDefaultAccounts, loadIssues, loadChargeTypes, loadTaxSettings]);

  function updateLineItem(index: number, itemId: string) {
    // Ganti item -> qty & harga baris sebelumnya gak relevan lagi, reset.
    setLines((prev) => prev.map((l, i) => (i === index ? { item_id: itemId, qty: "", amount: 0 } : l)));
  }

  function updateLineQty(index: number, change: UomQtyChange | null) {
    setLines((prev) =>
      prev.map((l, i) =>
        i === index ? { ...l, qty: change ? String(change.baseQty) : "", amount: change?.amount ?? 0 } : l
      )
    );
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  // Total pendapatan = Σ(qty x item_units.price) tiap baris, otomatis dari UomPriceQtyInput
  // -- gak ada lagi input manual (ref memory/domain/inventory.md submodule "Satuan Jual & Harga").
  const totalAmount = lines.reduce((sum, l) => sum + l.amount, 0);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const activeLines = lines.filter((l) => l.item_id.trim() !== "" && l.qty.trim() !== "");

    // UomPriceQtyInput udah ngonversi qty satuan terpilih -> qty satuan dasar (l.qty).
    // create_goods_issue tetap terima qty di satuan dasar, sama kayak sebelum fitur ini ada
    // (ref memory/domain/inventory.md submodule "Satuan Jual & Harga").
    const convertedLines = activeLines.map((l) => ({
      item_id: l.item_id,
      qty_issued: Number(l.qty),
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
    // Doc type ar_invoices, bukan goods_issues -- create_goods_issue sekaligus bikin baris
    // ar_invoices (form ini "Invoice + Goods Issue"), 1 source_ref dipakai bareng keduanya.
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

    setCustomerId("");
    setInvoiceDate("");
    setDescription("");
    setLines([emptyLine()]);
    setExtraLines([]);
    setApplyTax(false);
    setShowForm(false);
    await loadIssues();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  // Cuma barang yang punya minimal 1 item_units berharga yang bisa dijual lewat form ini --
  // harga wajib otomatis dari item_units.price, gak ada lagi jalur input manual (lihat
  // memory/domain/inventory.md submodule "Satuan Jual & Harga").
  const sellableItems = items.filter((item) =>
    itemUnits.some((u) => u.item_id === item.id && u.price != null)
  );

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Goods Issues</h1>
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
              <Button variant="toolbar-primary" onClick={() => setShowForm(true)}>
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
              <th className="px-4 py-2">Items Keluar (HPP, satuan dasar)</th>
              <th className="px-4 py-2 text-right">Pendapatan</th>
              <th className="px-4 py-2 text-right">Total HPP</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((gi) => {
              const totalHpp = gi.goods_issue_lines.reduce((sum, l) => sum + l.total_cost, 0);
              return (
                <tr
                  key={gi.id}
                  className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                  onClick={() => router.push(`/goods-issues/${gi.id}`)}
                >
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

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="Jual Barang Jadi (Invoice + Goods Issue)"
        maxWidth="max-w-4xl"
      >
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
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
                <Label htmlFor="description">Deskripsi</Label>
                <Input
                  id="description"
                  placeholder="mis. Jual barang ke Toko Kelontong Sumber Rejeki"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="amount">Jumlah Pendapatan</Label>
                <div
                  id="amount"
                  className="flex items-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900"
                >
                  Rp{totalAmount.toLocaleString("id-ID")}
                </div>
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
              <div className="grid grid-cols-[1fr_minmax(14rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Barang Jadi Keluar</span>
                <span>Qty & Satuan (harga otomatis)</span>
                <span />
              </div>
              {lines.map((line, i) => {
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
                      <UomPriceQtyInput
                        key={line.item_id}
                        units={unitsForItem}
                        onChange={(change) => updateLineQty(i, change)}
                      />
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
                  Belum ada barang dengan harga jual (item_units). Tambah satuan + harga di
                  halaman Items dulu.
                </p>
              )}
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah item
              </Button>
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
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Menyimpan..." : "Simpan Penjualan"}
              </Button>
            </div>
        </form>
      </Modal>
    </div>
  );
}
