"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { createGoodsReceiptSchema } from "@/lib/goods-receipts/schema";
import { normalizeReceiptLine, receiptTotals } from "@/lib/goods-receipts/calc";
import { useOpenPoolBills } from "@/lib/ap-bills/pool";
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
import {
  ItemDiscountInput,
  ReceiptDiscountSection,
  ReceiptTotalsCard,
} from "@/components/goods-receipts/receipt-form-parts";
import { PoolBillSelect, PoolSummary } from "@/components/goods-receipts/pool-bill-select";

type LineInput = { item_id: string; qty_received: string; unit_cost: string; item_discount: string };

function emptyLine(): LineInput {
  return { item_id: "", qty_received: "", unit_cost: "", item_discount: "" };
}

export function NewGoodsReceiptView({ initialBillId }: { initialBillId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const { items, itemUnits, remember } = useItemCache();

  const [billId, setBillId] = useState(initialBillId);
  const [receiptDate, setReceiptDate] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [lines, setLines] = useState<LineInput[]>([emptyLine()]);
  const [extraDiscount, setExtraDiscount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const billsQuery = useOpenPoolBills();
  const bills = billsQuery.data ?? [];
  const pool = bills.find((b) => b.bill_id === billId);

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

  // Baris dinormalkan ke presisi kolom tersimpan (harga dibulatkan ke atas, selisih jadi diskon baris) supaya nilai
  // bersih = nilai nota -- lihat normalizeReceiptLine.
  const activeLines = lines
    .filter((l) => l.item_id && parseFloat(l.qty_received) > 0 && l.unit_cost !== "")
    .map((l) => ({
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
        `Nilai barang masuk Rp${totals.total.toLocaleString("id-ID")} melebihi sisa kolam tagihan ${pool.bill_ref} (Rp${pool.remaining.toLocaleString("id-ID")}). Sisanya harus ditagih lewat tagihan lain.`
      );
      return;
    }

    const parsed = createGoodsReceiptSchema.safeParse({
      bill_id: pool.bill_id,
      receipt_date: receiptDate,
      delivery_note_ref: deliveryNoteRef || undefined,
      inventory_account_id: defaultAccounts["inventory.raw_material"]?.id ?? "",
      lines: activeLines.map((l) => ({
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
      p_order_id: null,
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
    router.push(initialBillId ? `/ap-bills/${parsed.data.bill_id}` : "/goods-receipts");
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink
        href={initialBillId ? `/ap-bills/${initialBillId}` : "/goods-receipts"}
        label={initialBillId ? "Kembali ke Detail Tagihan" : "Kembali ke Barang Masuk"}
      />

      <div>
        <h1 className="text-xl font-semibold text-black">Catat Barang Masuk</h1>
        <p className="text-sm text-slate-500">
          Barang masuk selalu dicatat dari satu tagihan barang yang sudah ada, dengan harga sesuai nota. Nilainya
          mengurangi sisa kolam tagihan itu dan tidak boleh melebihinya. Kalau notanya belum ada, buat dulu Tagihan
          Barang dari menu Tagihan (boleh dari nominal perkiraan). Kalau barang ini dipesan lewat PO, terima dari
          halaman detail PO-nya.
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
                {billId && !billsQuery.isLoading && !pool && (
                  <p className="text-xs text-amber-700">
                    Tagihan ini sudah tidak punya sisa kolam (atau dibatalkan), jadi tidak bisa dipakai untuk barang masuk baru.
                  </p>
                )}
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
            <p className="mb-3 text-sm font-medium text-black">Item Diterima</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Qty, Satuan & Harga (sesuai nota)</span>
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
