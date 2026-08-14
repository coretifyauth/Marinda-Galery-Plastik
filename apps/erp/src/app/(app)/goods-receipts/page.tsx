"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { poStatus, lineRemaining, type PurchaseOrder } from "@/lib/purchase-orders/schema";
import { createGoodsReceiptSchema, type GoodsReceiptNote } from "@/lib/goods-receipts/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import type { ApBillExpenseCategory } from "@/lib/ap-bill-expense-categories/schema";
import type { ItemUnit } from "@/lib/item-units/schema";
import { fetchTaxSettings, resolvedPpnMasukan, type TaxSettings } from "@/lib/tax-settings/schema";
import { resolveChargeLines, resolveChargeLineLegs, type ChargeLineInput } from "@/lib/charge-lines/schema";
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
import { UnitCostQtyInput, type UnitCostQtyChange } from "@/components/ui/unit-cost-qty-input";

type LineInput = {
  po_line_id: string;
  item_id: string;
  item_label: string;
  uom: string;
  qty_received: string;
  unit_cost: string;
};

export default function GoodsReceiptsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [receipts, setReceipts] = useState<GoodsReceiptNote[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [billDescription, setBillDescription] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [lines, setLines] = useState<LineInput[]>([]);
  const [extraLines, setExtraLines] = useState<ChargeLineInput[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ApBillExpenseCategory[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSettings | null>(null);
  const [applyTax, setApplyTax] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const receivablePOs = purchaseOrders.filter((po) => poStatus(po) !== "FULLY_RECEIVED");

  const loadReceipts = useCallback(async () => {
    const { data, error } = await supabase
      .from("goods_receipt_notes")
      .select(
        "id, purchase_order_id, bill_id, delivery_note_ref, receipt_date, created_at, purchase_orders(source_ref, suppliers(name)), ap_bills(source_ref, amount), goods_receipt_lines(id, item_id, qty_received, unit_cost, items(name, uom))"
      )
      .order("receipt_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setReceipts((data ?? []) as unknown as GoodsReceiptNote[]);
  }, []);

  const loadPurchaseOrders = useCallback(async () => {
    const { data } = await supabase
      .from("purchase_orders")
      .select(
        "id, supplier_id, po_date, expected_date, source_ref, created_at, suppliers(name), purchase_order_lines(id, item_id, qty_ordered, unit_cost_expected, items(name, uom), goods_receipt_lines(qty_received))"
      )
      .order("po_date", { ascending: false });
    setPurchaseOrders((data ?? []) as unknown as PurchaseOrder[]);
  }, []);

  const loadItemUnits = useCallback(async () => {
    const { data } = await supabase
      .from("item_units")
      .select("id, item_id, unit_label, conversion_factor, price, is_base");
    setItemUnits((data ?? []) as ItemUnit[]);
  }, []);

  const loadDefaultAccounts = useCallback(async () => {
    setDefaultAccounts(await fetchDefaultAccounts());
  }, []);

  const loadExpenseCategories = useCallback(async () => {
    const { data } = await supabase
      .from("ap_bill_expense_categories")
      .select("id, name, account_id, archived_at, accounts(code, name)")
      .order("name");
    setExpenseCategories((data ?? []) as unknown as ApBillExpenseCategory[]);
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
        loadPurchaseOrders(),
        loadItemUnits(),
        loadDefaultAccounts(),
        loadReceipts(),
        loadExpenseCategories(),
        loadTaxSettings(),
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [
    router,
    loadPurchaseOrders,
    loadItemUnits,
    loadDefaultAccounts,
    loadReceipts,
    loadExpenseCategories,
    loadTaxSettings,
  ]);

  function selectPurchaseOrder(poId: string) {
    setPurchaseOrderId(poId);
    const po = purchaseOrders.find((p) => p.id === poId);
    if (!po) {
      setLines([]);
      return;
    }
    setLines(
      po.purchase_order_lines
        .filter((l) => lineRemaining(l) > 0)
        .map((l) => ({
          po_line_id: l.id,
          item_id: l.item_id,
          item_label: `${l.items.name} (sisa ${lineRemaining(l)} ${l.items.uom})`,
          uom: l.items.uom,
          qty_received: String(lineRemaining(l)),
          unit_cost: String(l.unit_cost_expected),
        }))
    );
  }

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function updateLineQtyCost(index: number, change: UnitCostQtyChange | null) {
    updateLine(index, {
      qty_received: change ? String(change.baseQty) : "",
      unit_cost: change ? String(change.baseCost) : "",
    });
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const activeLines = lines.filter((l) => parseFloat(l.qty_received) > 0);

    const parsed = createGoodsReceiptSchema.safeParse({
      purchase_order_id: purchaseOrderId,
      receipt_date: receiptDate,
      delivery_note_ref: deliveryNoteRef || undefined,
      bill_description: billDescription || undefined,
      debit_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      lines: activeLines.map((l) => ({
        po_line_id: l.po_line_id,
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
      p_purchase_order_id: parsed.data.purchase_order_id,
      p_receipt_date: parsed.data.receipt_date,
      p_delivery_note_ref: parsed.data.delivery_note_ref || null,
      p_lines: parsed.data.lines,
      p_bill_description: parsed.data.bill_description || null,
      p_bill_source_ref: billSourceRef,
      p_debit_account_id: parsed.data.debit_account_id,
      p_payable_account_id: parsed.data.payable_account_id,
      p_extra_debit_lines: parsed.data.extra_debit_lines,
      p_apply_tax: parsed.data.apply_tax,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setPurchaseOrderId("");
    setReceiptDate("");
    setDeliveryNoteRef("");
    setBillDescription("");
    setLines([]);
    setExtraLines([]);
    setApplyTax(false);
    setShowForm(false);
    await Promise.all([loadReceipts(), loadPurchaseOrders()]);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Goods Receipts</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Goods Receipts</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {receipts.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadReceipts()}>
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
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">PO</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Items Diterima</th>
              <th className="px-4 py-2">Bill</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((grn) => (
              <tr
                key={grn.id}
                className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                onClick={() => router.push(`/goods-receipts/${grn.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">{grn.purchase_orders.suppliers.name}</td>
                <td className="px-4 py-2">{grn.purchase_orders.source_ref}</td>
                <td className="whitespace-nowrap px-4 py-2">{grn.receipt_date}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {grn.goods_receipt_lines.map((l) => (
                      <li key={l.id}>
                        {l.items.name} — {l.qty_received} {l.items.uom} @ {l.unit_cost.toLocaleString("id-ID")}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2">{grn.ap_bills.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {grn.ap_bills.amount.toLocaleString("id-ID")}
                </td>
              </tr>
            ))}
            {receipts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada goods receipt.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="Terima Barang + Bikin Bill"
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
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="po">Purchase Order</Label>
                <Select id="po" value={purchaseOrderId} onChange={(e) => selectPurchaseOrder(e.target.value)}>
                  <option value="">Pilih PO...</option>
                  {receivablePOs.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.source_ref} — {po.suppliers.name}
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
                <Label htmlFor="bill_description">Deskripsi Bill</Label>
                <Input
                  id="bill_description"
                  placeholder="mis. Terima tepung dari Toko Tepung Makmur"
                  value={billDescription}
                  onChange={(e) => setBillDescription(e.target.value)}
                />
              </div>
              <LockedAccountField
                label="Akun Persediaan (debit)"
                htmlFor="debit_account"
                resolved={defaultAccounts["inventory.raw_material"]}
              />
              <LockedAccountField
                label="Akun Utang Usaha (kredit)"
                htmlFor="payable_account"
                resolved={defaultAccounts["ap.payable"]}
              />
            </div>

            {purchaseOrderId && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2 text-sm font-medium text-slate-500">
                  <span>Item (sisa PO)</span>
                  <span>Qty, Satuan & Harga Riil</span>
                </div>
                {lines.length === 0 && (
                  <p className="text-sm text-slate-400">PO ini sudah diterima penuh.</p>
                )}
                {lines.map((line, i) => (
                  <div key={line.po_line_id} className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2">
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
            )}

            <ChargeLinesEditor
              label="Kategori Debit Tambahan (opsional — mis. ongkir supplier)"
              lines={extraLines}
              chargeTypes={expenseCategories}
              onChange={setExtraLines}
            />

            {taxSettings?.is_active && (
              <label className="flex w-fit items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={applyTax}
                  onChange={(e) => setApplyTax(e.target.checked)}
                />
                Kena PPN Masukan ({taxSettings.ppn_rate}%, dihitung otomatis dari subtotal)
              </label>
            )}

            {formError && <FormError>{formError}</FormError>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Batal
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Menyimpan..." : "Simpan Penerimaan"}
              </Button>
            </div>
        </form>
      </Modal>
    </div>
  );
}
