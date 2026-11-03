"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { fetchLinesForNotes } from "@/lib/goods-receipts/queries";
import { receiptNumber, type GoodsReceiptLine, type GoodsReceiptNote } from "@/lib/goods-receipts/types";
import { fetchItemUnitsForItems } from "@/lib/item-units/queries";
import type { ItemUnit } from "@/lib/item-units/schema";
import { todayLocal } from "@/lib/dates";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { ItemQty } from "@/components/ui/item-qty";
import { MultiUomQtyInput } from "@/components/ui/multi-uom-qty-input";
import { useConfirm } from "@/components/ui/confirm-dialog";

const rupiah = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 2 });
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Nilai bersih baris, sama dengan yang dijurnal: round(qty x harga, 2) - diskon. */
const lineValue = (l: GoodsReceiptLine) => round2(l.qty * l.unit_cost - (l.discount_amount ?? 0));

/**
 * Koreksi satuan/qty barang masuk LAMA (dibuat bareng tagihannya). Tagihan sudah benar, jadi NILAI tiap baris tetap dan
 * hanya qty yang diubah; harga per satuan dasar dihitung ulang otomatis. revise_legacy_goods_receipt (migration 0069).
 */
export default function LegacyReceiptCorrectionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [note, setNote] = useState<Omit<GoodsReceiptNote, "goods_note_lines"> | null>(null);
  const [lines, setLines] = useState<GoodsReceiptLine[]>([]);
  const [units, setUnits] = useState<ItemUnit[]>([]);
  const [newQty, setNewQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [entryDate, setEntryDate] = useState(todayLocal());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("goods_receipts_overview").select("*").eq("id", id).single();
    if (error || !data) {
      setLoadError(error?.message ?? "Barang masuk gak ditemukan.");
      setLoading(false);
      return;
    }
    const row = data as unknown as Omit<GoodsReceiptNote, "goods_note_lines">;
    const noteLines = (await fetchLinesForNotes([id])).get(id) ?? [];
    setNote(row);
    setLines(noteLines);
    setNewQty(Object.fromEntries(noteLines.map((l) => [l.id, String(l.qty)])));
    setUnits(await fetchItemUnitsForItems([...new Set(noteLines.map((l) => l.item_id))]));
    setLoading(false);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() adalah fetch async, pola yang sama dengan halaman koreksi lain
    void load();
  }, [load]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!note) return;
    setFormError(null);
    if (!reason.trim()) return setFormError("Alasan koreksi wajib diisi");

    const parsed = lines.map((l) => ({ line_id: l.id, qty: Number(newQty[l.id]) }));
    if (parsed.some((p) => !Number.isFinite(p.qty) || p.qty <= 0)) return setFormError("Qty tiap baris harus lebih dari 0");
    if (parsed.every((p, i) => p.qty === lines[i].qty)) return setFormError("Belum ada qty yang diubah");

    const ok = await confirm({
      title: "Koreksi Barang Masuk Lama",
      message:
        "Dokumen lama dibatalkan dan diganti dokumen baru dengan qty yang diisi. Nilai tiap baris dan tagihan tidak berubah. " +
        "Kalau sebagian barang sudah terjual, selisih harganya dikoreksi ke HPP pada tanggal koreksi. Lanjutkan?",
      confirmLabel: "Koreksi",
      danger: true,
    });
    if (!ok) return;

    setSubmitting(true);
    const { data, error } = await supabase.rpc("revise_legacy_goods_receipt", {
      p_goods_note_id: note.id,
      p_lines: parsed,
      p_reason: reason,
      p_entry_date: entryDate,
    });
    setSubmitting(false);
    if (error) return setFormError(error.message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["goods_receipt_notes"] }),
      queryClient.invalidateQueries({ queryKey: ["ap_bills"] }),
      queryClient.invalidateQueries({ queryKey: ["items"] }),
    ]);
    router.push(`/goods-receipts/${data as string}`);
  }

  if (loading) return <LoadingScreen />;
  if (!note) return <FormError>{loadError ?? "Barang masuk gak ditemukan."}</FormError>;

  if (!note.is_legacy || note.status === "dibatalkan") {
    return (
      <div className="flex w-full flex-1 flex-col gap-6">
        <BackLink href={`/goods-receipts/${id}`} label="Kembali ke Detail Barang Masuk" />
        <FormError>
          {note.status === "dibatalkan"
            ? "Barang masuk ini sudah dibatalkan atau digantikan koreksi, jadi tidak bisa dikoreksi lagi."
            : "Ini bukan barang masuk lama. Pakai Koreksi Barang Masuk biasa."}
        </FormError>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/goods-receipts/${id}`} label="Kembali ke Detail Barang Masuk" />
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Koreksi Barang Masuk Lama</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-sm text-slate-600">{receiptNumber(note)}</span>
        </div>
        <FormHint>
          Untuk satuan atau qty yang salah, saat tagihan dari supplier sudah benar. Isi qty yang BENAR per baris; nilai baris dan
          tagihan tidak berubah, harga per satuan dasar dihitung ulang otomatis.
        </FormHint>
      </div>

      <form onSubmit={handleSubmit} className="flex max-w-3xl flex-col gap-6">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="reason">Alasan Koreksi</Label>
              <Input
                id="reason"
                placeholder="mis. Satuan salah: 10 box tercatat 10 pcs"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="entry_date">Tanggal Koreksi</Label>
              <Input
                id="entry_date"
                type="date"
                min={note.note_date}
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
              <FormHint>Dipakai untuk mutasi stok dan, kalau ada, jurnal koreksi HPP.</FormHint>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {lines.map((l) => {
            const q = Number(newQty[l.id]);
            const value = lineValue(l);
            const valid = Number.isFinite(q) && q > 0;
            return (
              <div key={l.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-2 font-medium text-black">{l.items.name}</div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="text-sm">
                    <div className="text-slate-500">Tercatat</div>
                    <div>
                      <ItemQty itemId={l.item_id} qty={l.qty} uom={l.items.uom} />
                    </div>
                    <div className="text-xs text-slate-400">
                      Nilai Rp{rupiah(value)} · Rp{rupiah(value / l.qty)} / {l.items.uom}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Qty yang benar</Label>
                    <MultiUomQtyInput
                      units={units.filter((u) => u.item_id === l.item_id)}
                      baseUom={l.items.uom}
                      initialBaseQty={String(l.qty)}
                      onChange={(change) => setNewQty((prev) => ({ ...prev, [l.id]: change.baseQty }))}
                    />
                    {valid && (
                      <div className="text-xs text-slate-500">
                        Jadi <ItemQty itemId={l.item_id} qty={q} uom={l.items.uom} /> · Rp{rupiah(value / q)} / {l.items.uom}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {formError && <FormError>{formError}</FormError>}
        <div className="flex gap-2">
          <Button type="submit" variant="toolbar-primary" disabled={submitting}>
            {submitting ? "Menyimpan..." : "Simpan Koreksi"}
          </Button>
          <Button type="button" variant="toolbar" onClick={() => router.push(`/goods-receipts/${id}`)} disabled={submitting}>
            Batal
          </Button>
        </div>
      </form>
    </div>
  );
}
