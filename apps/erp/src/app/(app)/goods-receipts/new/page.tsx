"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { createGoodsReceiptSchema } from "@/lib/goods-receipts/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import type { ItemUnit } from "@/lib/item-units/schema";
import type { Item } from "@/lib/items/schema";
import type { Supplier } from "@/lib/suppliers/schema";
import { fetchTaxSettings, resolvedPpnMasukan, type TaxSettings } from "@/lib/tax-settings/schema";
import {
  resolveChargeLines,
  resolveChargeLineLegs,
  type ChargeLineInput,
  type ChargeCategoryWithAccount,
} from "@/lib/charge-lines/schema";
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
import { UnitCostQtyInput, type UnitCostQtyChange } from "@/components/ui/unit-cost-qty-input";
import { LoadingScreen } from "@/components/ui/loading-screen";

type LineInput = { item_id: string; qty_received: string; unit_cost: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_received: "", unit_cost: "" };
}

export default function NewGoodsReceiptPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const [supplierId, setSupplierId] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [billDescription, setBillDescription] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [discountAmount, setDiscountAmount] = useState("");
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ChargeCategoryWithAccount[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadSuppliers = useCallback(async () => {
    const { data } = await supabase
      .from("counterparties")
      .select("id, name, contact, payment_term_days, archived_at, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "supplier")
      .order("name");
    setSuppliers((data ?? []) as Supplier[]);
  }, []);

  const loadItems = useCallback(async () => {
    const [{ data: itemRows }, { data: unitRows }] = await Promise.all([
      supabase.from("items").select("id, name, item_type, uom, inventory_account_id, archived_at").order("name"),
      supabase.from("item_units").select("id, item_id, unit_label, conversion_factor, price, is_base"),
    ]);
    setItems((itemRows ?? []) as Item[]);
    setItemUnits((unitRows ?? []) as ItemUnit[]);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await Promise.all([
        loadSuppliers(),
        loadItems(),
        fetchDefaultAccounts().then(setDefaultAccounts),
        supabase
          .from("charge_categories")
          .select("id, name, account_id, archived_at, accounts(code, name)")
          .eq("module", "ap")
          .order("name")
          .then(({ data }) => setExpenseCategories((data ?? []) as unknown as ChargeCategoryWithAccount[])),
        fetchTaxSettings().then(setTaxSettings),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadSuppliers, loadItems]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function updateLineQtyCost(index: number, change: UnitCostQtyChange | null) {
    updateLine(index, {
      qty_received: change ? String(change.baseQty) : "",
      unit_cost: change ? String(change.baseCost) : "",
    });
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  const subtotal = lines.reduce(
    (sum, l) => sum + (parseFloat(l.qty_received) || 0) * (parseFloat(l.unit_cost) || 0),
    0
  );
  const totalDebit = subtotal - (parseFloat(discountAmount) || 0);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const activeLines = lines.filter((l) => parseFloat(l.qty_received) > 0);

    const parsed = createGoodsReceiptSchema.safeParse({
      supplier_id: supplierId,
      receipt_date: receiptDate,
      delivery_note_ref: deliveryNoteRef || undefined,
      bill_description: billDescription || undefined,
      debit_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      lines: activeLines.map((l) => ({
        item_id: l.item_id,
        qty_received: l.qty_received,
        unit_cost: l.unit_cost,
      })),
      extra_debit_lines: resolveChargeLines(extraLines, expenseCategories),
      apply_tax: applyTax,
      discount_amount: discountAmount || 0,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    let billSourceRef: string;
    try {
      billSourceRef = await generateDocumentNumber("ap_bills");
    } catch (err) {
      setSubmitting(false);
      setFormError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_goods_receipt", {
      p_order_id: null,
      p_receipt_date: parsed.data.receipt_date,
      p_delivery_note_ref: parsed.data.delivery_note_ref || null,
      p_lines: parsed.data.lines,
      p_bill_description: parsed.data.bill_description || null,
      p_bill_source_ref: billSourceRef,
      p_debit_account_id: parsed.data.debit_account_id,
      p_payable_account_id: parsed.data.payable_account_id,
      p_extra_debit_lines: parsed.data.extra_debit_lines,
      p_apply_tax: parsed.data.apply_tax,
      p_supplier_id: parsed.data.supplier_id,
      p_discount_amount: parsed.data.discount_amount,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    router.push("/goods-receipts");
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/goods-receipts" label="Kembali ke Barang Masuk" />

      <div>
        <h1 className="text-xl font-semibold text-black">Terima Barang Langsung</h1>
        <p className="text-sm text-slate-500">
          Barang Masuk + Tagihan tanpa Purchase Order — buat pembelian dadakan/tanpa pesanan sebelumnya.
          Kalau barang ini dipesan lewat PO, terima dari halaman detail PO-nya.
        </p>
      </div>

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="supplier">Supplier</Label>
                <Select id="supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">Pilih supplier...</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="receipt_date">Tanggal Terima</Label>
                <Input
                  id="receipt_date"
                  type="date"
                  value={receiptDate}
                  onChange={(e) => setReceiptDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="delivery_note_ref">No. Surat Jalan</Label>
                <Input
                  id="delivery_note_ref"
                  placeholder="mis. SJ-TEPUNG-003"
                  value={deliveryNoteRef}
                  onChange={(e) => setDeliveryNoteRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bill_description">Deskripsi Tagihan</Label>
                <Input
                  id="bill_description"
                  placeholder="mis. Terima tepung dari Toko Tepung Makmur"
                  value={billDescription}
                  onChange={(e) => setBillDescription(e.target.value)}
                />
              </div>
              <LockedAccountField htmlFor="debit_account" resolved={defaultAccounts["inventory.raw_material"]} />
              <LockedAccountField htmlFor="payable_account" resolved={defaultAccounts["ap.payable"]} />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Item Diterima</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty, Satuan & Harga Beli</span>
                <span />
              </div>
              {lines.map((line, i) => {
                const selectedItem = items.find((it) => it.id === line.item_id);
                const unitsForItem = itemUnits.filter((u) => u.item_id === line.item_id);
                return (
                  <div key={i} className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2">
                    <Select
                      value={line.item_id}
                      onChange={(e) => updateLine(i, { item_id: e.target.value, qty_received: "", unit_cost: "" })}
                    >
                      <option value="">Pilih item...</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.uom})
                        </option>
                      ))}
                    </Select>
                    {line.item_id ? (
                      <UnitCostQtyInput
                        key={line.item_id}
                        units={unitsForItem}
                        baseUom={selectedItem?.uom ?? ""}
                        onChange={(change) => updateLineQtyCost(i, change)}
                      />
                    ) : (
                      <span className="flex items-center text-xs text-slate-400">Pilih item dulu</span>
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
              <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
                + Tambah item
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="discount_amount">Diskon Pembelian (opsional — nominal Rupiah)</Label>
              <Input
                id="discount_amount"
                type="number"
                min="0"
                step="any"
                placeholder="mis. 50000"
                value={discountAmount}
                onChange={(e) => setDiscountAmount(e.target.value)}
              />
              <p className="text-xs text-slate-500">
                Potongan yang disepakati sama supplier saat penerimaan ini (trade discount) — langsung
                mengurangi nilai Utang Usaha, gak ada jurnal terpisah.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <ChargeLinesEditor
              label="Kategori Debit Tambahan (opsional — mis. ongkir supplier)"
              lines={extraLines}
              chargeTypes={expenseCategories}
              onChange={setExtraLines}
            />

            {taxSettings?.is_active && (
              <label className="mt-4 flex w-fit items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={applyTax} onChange={(e) => setApplyTax(e.target.checked)} />
                Kena PPN Masukan ({taxSettings.ppn_rate}%, dihitung otomatis dari subtotal)
              </label>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                {
                  label: "Akun Persediaan (debit)",
                  resolved: defaultAccounts["inventory.raw_material"],
                  side: "debit",
                },
                ...resolveChargeLineLegs(extraLines, expenseCategories, "debit"),
                { label: "Akun Utang Usaha (kredit)", resolved: defaultAccounts["ap.payable"], side: "credit" },
                applyTax && {
                  label: "Akun PPN Masukan (debit)",
                  resolved: resolvedPpnMasukan(taxSettings),
                  side: "debit",
                },
              ],
            ]}
          />

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>Subtotal</span>
              <span className="font-mono">Rp{subtotal.toLocaleString("id-ID")}</span>
            </div>
            {Number(discountAmount) > 0 && (
              <div className="flex items-center justify-between text-sm text-emerald-600">
                <span>Diskon</span>
                <span className="font-mono">-Rp{Number(discountAmount).toLocaleString("id-ID")}</span>
              </div>
            )}
            <p className="mt-2 text-sm text-slate-500">Nilai Tagihan</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{totalDebit.toLocaleString("id-ID")}</p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menyimpan..." : "Simpan Penerimaan"}
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
