"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { createGoodsReceiptSchema } from "@/lib/goods-receipts/schema";
import { receiptTotals } from "@/lib/goods-receipts/calc";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { UnitCostQtyInput, type UnitCostQtyChange } from "@/components/ui/unit-cost-qty-input";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { ItemPicker } from "@/components/pickers/item-picker";
import { useItemCache } from "@/lib/pickers/use-item-cache";
import { CounterpartyPicker } from "@/components/pickers/counterparty-picker";
import {
  ItemDiscountInput,
  ReceiptDiscountSection,
  ReceiptTotalsCard,
} from "@/components/goods-receipts/receipt-form-parts";

type LineInput = { item_id: string; qty_received: string; unit_cost: string; item_discount: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_received: "", unit_cost: "", item_discount: "" };
}

export default function NewGoodsReceiptPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const { items, itemUnits, remember } = useItemCache();

  const [supplierId, setSupplierId] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [extraDiscount, setExtraDiscount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await fetchDefaultAccounts().then(setDefaultAccounts);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

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

  const activeLines = lines.filter((l) => l.item_id && parseFloat(l.qty_received) > 0 && l.unit_cost !== "");
  const totals = receiptTotals(
    activeLines.map((l) => ({
      qty: parseFloat(l.qty_received) || 0,
      unitCost: parseFloat(l.unit_cost) || 0,
      itemDiscount: parseFloat(l.item_discount) || 0,
    })),
    parseFloat(extraDiscount) || 0
  );

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (totals.problems.length > 0) {
      setFormError(totals.problems[0]);
      return;
    }

    const parsed = createGoodsReceiptSchema.safeParse({
      supplier_id: supplierId,
      receipt_date: receiptDate,
      delivery_note_ref: deliveryNoteRef || undefined,
      inventory_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
      lines: activeLines.map((l) => ({
        item_id: l.item_id,
        qty_received: l.qty_received,
        unit_cost: l.unit_cost,
        discount_amount: l.item_discount || 0,
      })),
      discount_amount: extraDiscount || 0,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_goods_receipt", {
      p_order_id: null,
      p_receipt_date: parsed.data.receipt_date,
      p_delivery_note_ref: parsed.data.delivery_note_ref || null,
      p_lines: parsed.data.lines,
      p_inventory_account_id: parsed.data.inventory_account_id,
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
        <h1 className="text-xl font-semibold text-black">Catat Barang Masuk</h1>
        <p className="text-sm text-slate-500">
          Catat barang yang diterima dari supplier, tanpa menunggu nota. Tagihannya dibuat terpisah dari menu
          Tagihan begitu nota datang — pilih barang masuk ini di sana. Harga di sini boleh perkiraan (atau 0 kalau
          belum tahu) dan bisa direvisi selama belum ditagih. Kalau barang ini dipesan lewat PO, terima dari halaman
          detail PO-nya.
        </p>
      </div>

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="supplier">Supplier</Label>
                <CounterpartyPicker id="supplier" role="supplier" value={supplierId} onChange={setSupplierId} />
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
              <LockedAccountField htmlFor="debit_account" resolved={defaultAccounts["inventory.raw_material"]} />
              <LockedAccountField
                htmlFor="grni_account"
                label="Akun Barang Diterima Belum Ditagih (kredit)"
                resolved={defaultAccounts["inventory.goods_received_not_invoiced"]}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Item Diterima</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty, Satuan & Harga Perkiraan</span>
                <span />
              </div>
              {lines.map((line, i) => {
                const selectedItem = items.find((it) => it.id === line.item_id);
                const unitsForItem = itemUnits.filter((u) => u.item_id === line.item_id);
                return (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2 border-b border-slate-200 pb-3 last:border-b-0 last:pb-0"
                  >
                    <ItemPicker
                      value={line.item_id}
                      onChange={(id) => updateLine(i, { item_id: id, qty_received: "", unit_cost: "", item_discount: "" })}
                      onResolve={remember}
                    />
                    {line.item_id ? (
                      <div className="flex flex-col gap-2">
                        <UnitCostQtyInput
                          key={line.item_id}
                          units={unitsForItem}
                          baseUom={selectedItem?.uom ?? ""}
                          allowZeroCost
                          onChange={(change) => updateLineQtyCost(i, change)}
                        />
                        <ItemDiscountInput
                          value={line.item_discount}
                          onChange={(v) => updateLine(i, { item_discount: v })}
                        />
                      </div>
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

          <ReceiptDiscountSection totals={totals} extraDiscount={extraDiscount} onExtraChange={setExtraDiscount} />
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          <JournalPreviewPanel
            groups={[
              totals.total > 0 && [
                {
                  label: "Akun Persediaan (debit)",
                  resolved: defaultAccounts["inventory.raw_material"],
                  side: "debit",
                },
                {
                  label: "Akun Barang Diterima Belum Ditagih (kredit)",
                  resolved: defaultAccounts["inventory.goods_received_not_invoiced"],
                  side: "credit",
                },
              ],
            ]}
          />
          {totals.total <= 0 && (
            <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
              Nilai barang masuk 0, jadi belum ada jurnal. Stok fisik tetap bertambah.
            </p>
          )}

          <ReceiptTotalsCard totals={totals} />

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menyimpan..." : "Simpan Barang Masuk"}
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
