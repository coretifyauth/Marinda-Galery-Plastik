"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { fetchLinesForNotes } from "@/lib/goods-receipts/queries";
import { receiptNumber, type GoodsReceiptNote } from "@/lib/goods-receipts/types";
import { grnLineSchema } from "@/lib/goods-receipts/schema";
import { normalizeReceiptLine, receiptTotals } from "@/lib/goods-receipts/calc";
import { confirmPriceDeviations } from "@/lib/goods-receipts/price-check";
import { usePool } from "@/lib/ap-bills/pool";
import { useItemCache } from "@/lib/pickers/use-item-cache";
import { todayLocal } from "@/lib/dates";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { UnitCostQtyInput, type UnitCostQtyChange } from "@/components/ui/unit-cost-qty-input";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { ItemPicker } from "@/components/pickers/item-picker";
import {
  ItemDiscountInput,
  ReceiptDiscountSection,
  ReceiptTotalsCard,
} from "@/components/goods-receipts/receipt-form-parts";
import { PoolSummary } from "@/components/goods-receipts/pool-bill-select";

type LineInput = {
  key: string;
  order_line_id: string;
  item_id: string;
  qty_received: string;
  unit_cost: string;
  item_discount: string;
};

/**
 * Koreksi Barang Masuk: isi nilai yang BENAR. Dokumen lama dibatalkan dan dokumen baru dibuat dalam satu transaksi
 * (revise_goods_receipt, migration 0060), jadi tetap bisa walau sebagian barang sudah terjual. Selisih harga atas barang yang
 * sudah terjual masuk HPP periode berjalan. Lihat docs/domain/inventory.md "Koreksi Barang Masuk".
 */
export default function GoodsReceiptCorrectionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const { items, itemUnits, remember } = useItemCache();
  const [note, setNote] = useState<GoodsReceiptNote | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [receiptDate, setReceiptDate] = useState("");
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [lines, setLines] = useState<LineInput[]>([]);
  const [extraDiscount, setExtraDiscount] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const poolQuery = usePool(note?.bill_id ?? "");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("goods_receipts_overview").select("*").eq("id", id).single();
    if (error || !data) {
      setLoadError(error?.message ?? "Barang masuk gak ditemukan.");
      return;
    }
    const row = data as unknown as Omit<GoodsReceiptNote, "goods_note_lines">;
    const [lineMap, { data: orderLinks }] = await Promise.all([
      fetchLinesForNotes([id]),
      supabase.from("goods_note_lines").select("id, order_line_id").eq("goods_note_id", id),
    ]);
    const orderLineByLine = new Map(
      ((orderLinks ?? []) as { id: string; order_line_id: string | null }[]).map((l) => [l.id, l.order_line_id])
    );
    const noteLines = lineMap.get(id) ?? [];
    setNote({ ...row, goods_note_lines: noteLines });
    setReceiptDate(row.note_date);
    setDeliveryNoteRef(row.delivery_note_ref ?? "");
    setLines(
      noteLines.map((l) => ({
        key: l.id,
        order_line_id: orderLineByLine.get(l.id) ?? "",
        item_id: l.item_id,
        qty_received: String(l.qty),
        unit_cost: String(l.unit_cost),
        item_discount: l.discount_amount ? String(l.discount_amount) : "",
      }))
    );
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await load();
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

  const activeLines = lines
    .filter((l) => l.item_id && parseFloat(l.qty_received) > 0 && l.unit_cost !== "")
    .map((l) => ({
      order_line_id: l.order_line_id,
      item_id: l.item_id,
      ...normalizeReceiptLine(parseFloat(l.qty_received) || 0, parseFloat(l.unit_cost) || 0, parseFloat(l.item_discount) || 0),
    }));
  const totals = receiptTotals(
    activeLines.map((l) => ({ qty: l.qty, unitCost: l.unitCost, itemDiscount: l.discount })),
    parseFloat(extraDiscount) || 0
  );

  // Nilai dokumen lama kembali ke "belum diterima" begitu dikoreksi, jadi batasnya sisa + nilai lama.
  const basePool = poolQuery.data ?? null;
  const pool =
    basePool && note
      ? {
          ...basePool,
          received_value: basePool.received_value - note.total_value,
          remaining: basePool.remaining + note.total_value,
        }
      : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!note || !pool) return;
    if (!reason.trim()) return setFormError("Alasan koreksi wajib diisi");
    if (!receiptDate) return setFormError("Tanggal terima wajib diisi");
    if (activeLines.length === 0) {
      return setFormError("Minimal 1 baris barang. Kalau barangnya memang tidak ada, pakai Batalkan Barang Masuk.");
    }
    if (totals.problems.length > 0) return setFormError(totals.problems[0]);
    if (totals.total > pool.remaining + 0.005) {
      return setFormError(
        `Nilai koreksi Rp${totals.total.toLocaleString("id-ID")} melebihi nilai barang tagihan ${pool.bill_ref} yang tersedia (Rp${pool.remaining.toLocaleString("id-ID")}). Naikkan dulu lewat Koreksi Tagihan.`
      );
    }

    const parsedLines = [];
    for (const l of activeLines) {
      const parsed = grnLineSchema.safeParse({
        order_line_id: l.order_line_id || undefined,
        item_id: l.item_id,
        qty_received: l.qty,
        unit_cost: l.unitCost,
        discount_amount: l.discount,
      });
      if (!parsed.success) return setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      parsedLines.push(parsed.data);
    }

    const priceOk = await confirmPriceDeviations(
      activeLines.map((l) => ({
        itemId: l.item_id,
        itemName: items.find((it) => it.id === l.item_id)?.name ?? "Barang",
        netUnitCost: (l.qty * l.unitCost - l.discount) / l.qty,
      }))
    );
    if (!priceOk) return;

    setSubmitting(true);
    const { data, error } = await supabase.rpc("revise_goods_receipt", {
      p_goods_note_id: note.id,
      p_receipt_date: receiptDate,
      p_delivery_note_ref: deliveryNoteRef || null,
      p_lines: parsedLines,
      p_discount_amount: parseFloat(extraDiscount) || 0,
      p_reason: reason,
      p_entry_date: todayLocal(),
    });
    setSubmitting(false);
    if (error) return setFormError(error.message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["goods_receipt_notes"] }),
      queryClient.invalidateQueries({ queryKey: ["open_pool_bills"] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bill_pool", note.bill_id] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] }),
    ]);
    router.push(`/goods-receipts/${data as string}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!note) {
    return <FormError>{loadError ?? "Barang masuk gak ditemukan."}</FormError>;
  }

  if (note.status === "dibatalkan" || note.is_legacy) {
    return (
      <div className="flex w-full flex-1 flex-col gap-6">
        <BackLink href={`/goods-receipts/${id}`} label="Kembali ke Detail Barang Masuk" />
        <FormError>
          {note.is_legacy
            ? "Barang masuk lama (dibuat bareng tagihannya) belum punya jalur koreksi. Batalkan lewat tagihannya kalau stoknya masih utuh."
            : "Barang masuk ini sudah dibatalkan, jadi tidak bisa dikoreksi."}
        </FormError>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/goods-receipts/${id}`} label="Kembali ke Detail Barang Masuk" />

      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Koreksi Barang Masuk</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">{receiptNumber(note)}</span>
        </div>
        <p className="text-sm text-slate-500">
          Isi barang, qty, dan harga yang BENAR. Dokumen ini dibatalkan dan diganti dokumen baru. Bisa dipakai walau sebagian
          barang sudah terjual. Selisih harga atas barang yang sudah terjual otomatis masuk HPP periode berjalan.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {pool && (
                <div className="sm:col-span-2">
                  <PoolSummary pool={pool} receiving={totals.total} />
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="receipt_date">Tanggal Terima</Label>
                <Input id="receipt_date" type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="delivery_note_ref">No. Surat Jalan</Label>
                <Input id="delivery_note_ref" value={deliveryNoteRef} onChange={(e) => setDeliveryNoteRef(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="reason">Alasan Koreksi</Label>
                <Input
                  id="reason"
                  placeholder="mis. Qty salah hitung, nota tertulis 80 pcs"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Barang yang Benar</p>
            <div className="flex flex-col gap-2">
              {lines.map((line, i) => {
                const selectedItem = items.find((it) => it.id === line.item_id);
                return (
                  <div
                    key={line.key}
                    className="grid grid-cols-[1fr_minmax(16rem,auto)_2.5rem] gap-2 border-b border-slate-200 pb-3 last:border-b-0 last:pb-0"
                  >
                    <ItemPicker
                      value={line.item_id}
                      onChange={(itemId) =>
                        updateLine(i, { item_id: itemId, order_line_id: "", qty_received: "", unit_cost: "", item_discount: "", key: `${line.key}-${itemId}` })
                      }
                      onResolve={remember}
                    />
                    {line.item_id && selectedItem ? (
                      <div className="flex flex-col gap-2">
                        <UnitCostQtyInput
                          key={line.key}
                          units={itemUnits.filter((u) => u.item_id === line.item_id)}
                          baseUom={selectedItem.uom}
                          initialBaseQty={line.qty_received}
                          initialBaseCost={line.unit_cost}
                          onChange={(change) => updateLineQtyCost(i, change)}
                        />
                        <ItemDiscountInput value={line.item_discount} onChange={(v) => updateLine(i, { item_discount: v })} />
                      </div>
                    ) : (
                      <span className="flex items-center text-xs text-slate-400">Pilih item dulu</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                      disabled={lines.length <= 1}
                      className="text-slate-400 hover:text-red-600 disabled:opacity-30"
                      aria-label="Hapus baris"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="secondary"
                className="w-fit"
                onClick={() =>
                  setLines((prev) => [
                    ...prev,
                    { key: crypto.randomUUID(), order_line_id: "", item_id: "", qty_received: "", unit_cost: "", item_discount: "" },
                  ])
                }
              >
                + Tambah item
              </Button>
            </div>
          </div>

          <ReceiptDiscountSection totals={totals} extraDiscount={extraDiscount} onExtraChange={setExtraDiscount} />
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm shadow-sm">
            <div className="flex justify-between gap-2 text-slate-500">
              <span>Nilai lama</span>
              <span className="font-mono">Rp{note.total_value.toLocaleString("id-ID")}</span>
            </div>
          </div>
          <ReceiptTotalsCard totals={totals} />
          {formError && <FormError>{formError}</FormError>}
          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menyimpan..." : "Simpan Koreksi"}
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
