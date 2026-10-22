"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { lineRemaining, type PurchaseOrder } from "@/lib/purchase-orders/schema";
import { createGoodsReceiptSchema } from "@/lib/goods-receipts/schema";
import { normalizeReceiptLine, receiptTotals } from "@/lib/goods-receipts/calc";
import { useOpenPoolBills } from "@/lib/ap-bills/pool";
import type { ItemUnit } from "@/lib/item-units/schema";
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
import {
  ItemDiscountInput,
  ReceiptDiscountSection,
  ReceiptTotalsCard,
} from "@/components/goods-receipts/receipt-form-parts";
import { PoolBillSelect, PoolSummary } from "@/components/goods-receipts/pool-bill-select";

type LineInput = {
  order_line_id: string;
  item_id: string;
  item_label: string;
  uom: string;
  qty_received: string;
  unit_cost: string;
  item_discount: string;
};

export default function ReceivePurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [billId, setBillId] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [lines, setLines] = useState<LineInput[]>([]);
  const [extraDiscount, setExtraDiscount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Hanya tagihan barang milik supplier PO ini yang masih punya sisa kolam.
  const billsQuery = useOpenPoolBills(po?.counterparty_id, !!po);
  const bills = billsQuery.data ?? [];
  const pool = bills.find((b) => b.bill_id === billId);

  const load = useCallback(async () => {
    const { data: poData, error: poErr } = await supabase
      .from("orders")
      .select(
        "id, counterparty_id, order_date, expected_date, source_ref, created_at, cancelled_at, counterparties(name), order_lines(id, item_id, qty_ordered, unit_price, items(name, uom), goods_note_lines(qty, goods_notes(transactions(status), goods_note_cancellations(goods_note_id))))"
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
          item_discount: "",
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
      ]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function updateLineQtyCost(index: number, change: UnitCostQtyChange | null) {
    updateLine(index, {
      qty_received: change ? String(change.baseQty) : "",
      unit_cost: change ? String(change.baseCost) : "",
    });
  }

  // Baris dinormalkan ke presisi kolom tersimpan (harga dibulatkan ke atas, selisih jadi diskon baris) supaya nilai
  // bersih = nilai nota -- lihat normalizeReceiptLine.
  const activeLines = lines
    .filter((l) => parseFloat(l.qty_received) > 0 && l.unit_cost !== "")
    .map((l) => ({
      order_line_id: l.order_line_id,
      item_id: l.item_id,
      ...normalizeReceiptLine(parseFloat(l.qty_received) || 0, parseFloat(l.unit_cost) || 0, parseFloat(l.item_discount) || 0),
    }));
  const totals = receiptTotals(
    activeLines.map((l) => ({ qty: l.qty, unitCost: l.unitCost, itemDiscount: l.discount })),
    parseFloat(extraDiscount) || 0
  );

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!po) return;

    if (!pool) {
      setFormError("Pilih tagihan barang tempat barang ini dicatat");
      return;
    }
    if (totals.problems.length > 0) {
      setFormError(totals.problems[0]);
      return;
    }
    if (totals.total > pool.remaining + 0.005) {
      setFormError(
        `Nilai barang masuk Rp${totals.total.toLocaleString("id-ID")} melebihi barang yang belum diterima dari nota ${pool.bill_ref} (Rp${pool.remaining.toLocaleString("id-ID")}). Sisanya harus ditagih lewat tagihan lain.`
      );
      return;
    }

    const parsed = createGoodsReceiptSchema.safeParse({
      bill_id: pool.bill_id,
      order_id: po.id,
      receipt_date: receiptDate,
      delivery_note_ref: deliveryNoteRef || undefined,
      inventory_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
      lines: activeLines.map((l) => ({
        order_line_id: l.order_line_id,
        item_id: l.item_id,
        qty_received: l.qty,
        unit_cost: l.unitCost,
        discount_amount: l.discount,
      })),
      discount_amount: extraDiscount || 0,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_goods_receipt", {
      p_bill_id: parsed.data.bill_id,
      p_receipt_date: parsed.data.receipt_date,
      p_delivery_note_ref: parsed.data.delivery_note_ref || null,
      p_lines: parsed.data.lines,
      p_inventory_account_id: parsed.data.inventory_account_id,
      p_order_id: parsed.data.order_id ?? null,
      p_discount_amount: parsed.data.discount_amount,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["goods_receipt_notes"] }),
      queryClient.invalidateQueries({ queryKey: ["open_pool_bills"] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bill_pool", parsed.data.bill_id] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] }),
    ]);

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
          <h1 className="text-xl font-semibold text-black">Catat Barang Masuk dari PO</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {po.source_ref}
          </span>
        </div>
        <p className="text-sm text-slate-500">
          Supplier: {po.counterparties.name}. Barang masuk dicatat dari satu tagihan barang supplier ini, dengan harga
          sesuai nota; nilainya mengurangi barang yang belum diterima dari nota itu. Belum ada tagihannya? Buat dulu Tagihan Barang dari
          menu Tagihan.
        </p>
      </div>

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="bill">Tagihan Barang</Label>
                <PoolBillSelect id="bill" bills={bills} value={billId} onChange={setBillId} loading={billsQuery.isLoading} />
                {billsQuery.error && <FormError>{(billsQuery.error as Error).message}</FormError>}
              </div>
              {pool && (
                <div className="sm:col-span-2">
                  <PoolSummary pool={pool} receiving={totals.total} />
                </div>
              )}
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
                htmlFor="pbd_account"
                label="Akun Pembelian Belum Diterima (kredit)"
                resolved={defaultAccounts["inventory.purchase_not_received"]}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Item yang Diterima (sisa PO)</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty, Satuan & Harga (sesuai nota)</span>
              </div>
              {lines.length === 0 && <p className="text-sm text-slate-400">PO ini sudah diterima penuh.</p>}
              {lines.map((line, i) => (
                <div
                  key={line.order_line_id}
                  className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2 border-b border-slate-200 pb-3 last:border-b-0 last:pb-0"
                >
                  <span className="flex items-center text-sm text-slate-700">{line.item_label}</span>
                  <div className="flex flex-col gap-2">
                    <UnitCostQtyInput
                      units={itemUnits.filter((u) => u.item_id === line.item_id)}
                      baseUom={line.uom}
                      initialBaseQty={line.qty_received}
                      initialBaseCost={line.unit_cost}
                      onChange={(change) => updateLineQtyCost(i, change)}
                    />
                    <ItemDiscountInput value={line.item_discount} onChange={(v) => updateLine(i, { item_discount: v })} />
                  </div>
                </div>
              ))}
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
                  label: "Akun Pembelian Belum Diterima (kredit)",
                  resolved: defaultAccounts["inventory.purchase_not_received"],
                  side: "credit",
                },
              ],
            ]}
          />

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
