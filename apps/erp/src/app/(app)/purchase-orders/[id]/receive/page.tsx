"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { lineRemaining, type PurchaseOrder } from "@/lib/purchase-orders/schema";
import { createGoodsReceiptSchema } from "@/lib/goods-receipts/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import type { ItemUnit } from "@/lib/item-units/schema";
import { fetchTaxSettings, resolvedPpnMasukan, type TaxSettings } from "@/lib/tax-settings/schema";
import {
  resolveChargeLines,
  resolveChargeLineLegs,
  type ChargeLineInput,
  type ChargeCategoryWithAccount,
} from "@/lib/charge-lines/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { ChargeLinesEditor } from "@/components/ui/charge-lines-editor";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { UnitCostQtyInput, type UnitCostQtyChange } from "@/components/ui/unit-cost-qty-input";
import { LoadingScreen } from "@/components/ui/loading-screen";

type LineInput = {
  order_line_id: string;
  item_id: string;
  item_label: string;
  uom: string;
  qty_received: string;
  unit_cost: string;
};

export default function ReceivePurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [receiptDate, setReceiptDate] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [billDescription, setBillDescription] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [lines, setLines] = useState<LineInput[]>([]);
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ChargeCategoryWithAccount[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: poData, error: poErr } = await supabase
      .from("orders")
      .select(
        "id, counterparty_id, order_date, expected_date, source_ref, created_at, cancelled_at, counterparties(name), order_lines(id, item_id, qty_ordered, unit_price, items(name, uom), goods_note_lines(qty))"
      )
      .eq("id", id)
      .eq("direction", "PURCHASE")
      .single();
    if (poErr || !poData) {
      setLoadError(poErr?.message ?? "Purchase order gak ditemukan.");
      return;
    }
    const typedPo = poData as unknown as PurchaseOrder;
    setPo(typedPo);
    setLines(
      typedPo.order_lines
        .filter((l) => lineRemaining(l) > 0)
        .map((l) => ({
          order_line_id: l.id,
          item_id: l.item_id,
          item_label: `${l.items.name} (sisa ${lineRemaining(l)} ${l.items.uom})`,
          uom: l.items.uom,
          qty_received: String(lineRemaining(l)),
          unit_cost: String(l.unit_price),
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
          .from("item_units")
          .select("id, item_id, unit_label, conversion_factor, price, is_base")
          .then(({ data }) => setItemUnits((data ?? []) as ItemUnit[])),
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
  }, [router, load]);

  function updateLineQtyCost(index: number, change: UnitCostQtyChange | null) {
    setLines((prev) =>
      prev.map((l, i) =>
        i === index
          ? { ...l, qty_received: change ? String(change.baseQty) : "", unit_cost: change ? String(change.baseCost) : "" }
          : l
      )
    );
  }

  const totalDebit = lines.reduce(
    (sum, l) => sum + (parseFloat(l.qty_received) || 0) * (parseFloat(l.unit_cost) || 0),
    0
  );

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!po) return;

    const activeLines = lines.filter((l) => parseFloat(l.qty_received) > 0);

    const parsed = createGoodsReceiptSchema.safeParse({
      order_id: po.id,
      receipt_date: receiptDate,
      delivery_note_ref: deliveryNoteRef || undefined,
      bill_description: billDescription || undefined,
      debit_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      lines: activeLines.map((l) => ({
        order_line_id: l.order_line_id,
        item_id: l.item_id,
        qty_received: l.qty_received,
        unit_cost: l.unit_cost,
      })),
      extra_debit_lines: resolveChargeLines(extraLines, expenseCategories),
      apply_tax: applyTax,
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
      p_order_id: parsed.data.order_id ?? null,
      p_receipt_date: parsed.data.receipt_date,
      p_delivery_note_ref: parsed.data.delivery_note_ref || null,
      p_lines: parsed.data.lines,
      p_bill_description: parsed.data.bill_description || null,
      p_bill_source_ref: billSourceRef,
      p_debit_account_id: parsed.data.debit_account_id,
      p_payable_account_id: parsed.data.payable_account_id,
      p_extra_debit_lines: parsed.data.extra_debit_lines,
      p_apply_tax: parsed.data.apply_tax,
      p_supplier_id: null,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    router.push(`/purchase-orders/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!po) {
    return <FormError>{loadError ?? "Purchase order gak ditemukan."}</FormError>;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/purchase-orders/${id}`} label="Kembali ke Detail Purchase Order" />

      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Terima Barang & Bikin Tagihan</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {po.source_ref}
          </span>
        </div>
        <p className="text-sm text-slate-500">Supplier: {po.counterparties.name}.</p>
      </div>

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              <div className="flex flex-col gap-1.5 sm:col-span-2">
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
            <p className="mb-3 text-sm font-medium text-black">Item yang Diterima (sisa PO)</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty, Satuan & Harga Riil</span>
              </div>
              {lines.length === 0 && <p className="text-sm text-slate-400">PO ini sudah diterima penuh.</p>}
              {lines.map((line, i) => (
                <div key={line.order_line_id} className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2">
                  <span className="flex items-center text-sm text-slate-700">{line.item_label}</span>
                  <UnitCostQtyInput
                    units={itemUnits.filter((u) => u.item_id === line.item_id)}
                    baseUom={line.uom}
                    initialBaseQty={line.qty_received}
                    initialBaseCost={line.unit_cost}
                    onChange={(change) => updateLineQtyCost(i, change)}
                  />
                </div>
              ))}
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
            <p className="text-sm text-slate-500">Nilai Tagihan</p>
            <p className="mt-1 font-mono text-2xl text-black">
              Rp{totalDebit.toLocaleString("id-ID")}
            </p>
          </div>

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menyimpan..." : "Terima & Terbitkan Tagihan"}
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
