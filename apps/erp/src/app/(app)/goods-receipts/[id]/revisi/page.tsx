"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { fetchLinesForNotes } from "@/lib/goods-receipts/queries";
import { receiptTotals } from "@/lib/goods-receipts/calc";
import { receiptNumber, type GoodsReceiptNote } from "@/lib/goods-receipts/types";
import { fetchItemUnitsForItems } from "@/lib/item-units/queries";
import type { ItemUnit } from "@/lib/item-units/schema";
import { formatStockBreakdown } from "@/lib/stock-display";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { UnitPriceField } from "@/components/ui/unit-price-field";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import {
  ItemDiscountInput,
  ReceiptDiscountSection,
  ReceiptTotalsCard,
} from "@/components/goods-receipts/receipt-form-parts";

type LineInput = {
  line_id: string;
  item_id: string;
  name: string;
  uom: string;
  qty: number;
  unit_cost: string; // per satuan dasar
  line_discount: string;
};

export default function ReviseGoodsReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [grn, setGrn] = useState<Omit<GoodsReceiptNote, "goods_note_lines"> | null>(null);
  const [lines, setLines] = useState<LineInput[]>([]);
  const [itemUnits, setItemUnits] = useState<ItemUnit[]>([]);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [extraDiscount, setExtraDiscount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("goods_notes_with_billing_status")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) {
      setLoadError(error?.message ?? "Barang masuk gak ditemukan.");
      return;
    }
    const note = data as unknown as Omit<GoodsReceiptNote, "goods_note_lines">;
    const lineMap = await fetchLinesForNotes([id]);
    const noteLines = lineMap.get(id) ?? [];
    const units = await fetchItemUnitsForItems([...new Set(noteLines.map((l) => l.item_id))]);

    setGrn(note);
    setItemUnits(units);
    setDeliveryNoteRef(note.delivery_note_ref ?? "");
    setLines(
      noteLines.map((l) => ({
        line_id: l.id,
        item_id: l.item_id,
        name: l.items.name,
        uom: l.items.uom,
        qty: l.qty,
        unit_cost: String(l.unit_cost),
        line_discount: l.discount_amount > 0 ? String(l.discount_amount) : "",
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
      const { data: roleRows } = await supabase
        .from("app_user_roles")
        .select("role_name")
        .eq("user_id", session.user.id);
      if (!active) return;
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      await Promise.all([load(), fetchDefaultAccounts().then(setDefaultAccounts)]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  function updateLine(index: number, patch: Partial<LineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  const totals = receiptTotals(
    lines.map((l) => ({
      qty: l.qty,
      unitCost: parseFloat(l.unit_cost) || 0,
      itemDiscount: parseFloat(l.line_discount) || 0,
    })),
    parseFloat(extraDiscount) || 0
  );
  const previousValue = grn?.total_value ?? 0;
  const delta = totals.total - previousValue;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!grn) return;

    if (lines.some((l) => l.unit_cost.trim() === "" || Number.isNaN(Number(l.unit_cost)))) {
      setFormError("Isi harga semua baris (boleh 0)");
      return;
    }
    if (totals.problems.length > 0) {
      setFormError(totals.problems[0]);
      return;
    }
    const inventoryAccountId = defaultAccounts["inventory.raw_material"]?.id;
    if (!inventoryAccountId) {
      setFormError("Default Akun Persediaan belum diset");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("revise_goods_receipt", {
      p_goods_note_id: grn.id,
      p_entry_date: entryDate,
      p_lines: lines.map((l) => ({
        goods_note_line_id: l.line_id,
        unit_cost: Number(l.unit_cost),
        discount_amount: l.line_discount === "" ? 0 : Number(l.line_discount),
      })),
      p_inventory_account_id: inventoryAccountId,
      p_delivery_note_ref: deliveryNoteRef || null,
      p_discount_amount: extraDiscount === "" ? 0 : Number(extraDiscount),
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    router.push(`/goods-receipts/${grn.id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!grn) {
    return <FormError>{loadError ?? "Barang masuk gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const revisable = grn.inbound_flow === "deferred" && grn.billing_status === "belum_tertagih";

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/goods-receipts/${id}`} label="Kembali ke Detail Barang Masuk" />

      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Revisi Harga / Diskon</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {receiptNumber(grn)}
          </span>
        </div>
        <p className="text-sm text-slate-500">
          Ubah harga atau diskon barang masuk selama belum ditagih. Item dan qty tidak bisa diubah — kalau salah item
          atau qty, batalkan lalu catat ulang. Jurnal lama dibalik (bertanggal revisi) dan jurnal baru dibuat. Stok dan
          harga rata-rata tidak berubah; harga rata-rata baru dihitung saat tagihan dibuat.
        </p>
      </div>

      {!revisable && (
        <FormError>
          Barang masuk ini berstatus {grn.billing_status.replace("_", " ")} — revisi cuma bisa dilakukan selama belum
          ditagih dan dibuat dengan alur baru.
        </FormError>
      )}
      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="entry_date">Tanggal Revisi</Label>
                <Input id="entry_date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="delivery_note_ref">No. Surat Jalan</Label>
                <Input
                  id="delivery_note_ref"
                  value={deliveryNoteRef}
                  onChange={(e) => setDeliveryNoteRef(e.target.value)}
                />
              </div>
              <LockedAccountField htmlFor="debit_account" resolved={defaultAccounts["inventory.raw_material"]} />
              <LockedAccountField
                htmlFor="grni_account"
                label="Akun Barang Diterima Belum Ditagih"
                resolved={defaultAccounts["inventory.goods_received_not_invoiced"]}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-3 text-sm font-medium text-black">Item (qty tetap)</p>
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2 text-sm font-medium text-slate-500">
                <span>Item</span>
                <span>Harga & Diskon</span>
              </div>
              {lines.map((line, i) => {
                const unitsForItem = itemUnits.filter((u) => u.item_id === line.item_id);
                return (
                  <div
                    key={line.line_id}
                    className="grid grid-cols-[1fr_minmax(16rem,auto)] gap-2 border-b border-slate-200 pb-3 last:border-b-0 last:pb-0"
                  >
                    <div className="flex flex-col justify-center">
                      <span className="text-sm text-slate-700">{line.name}</span>
                      <span className="text-xs text-slate-400">
                        Qty: {formatStockBreakdown(line.qty, line.uom, unitsForItem)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">
                      <UnitPriceField
                        units={unitsForItem}
                        baseUom={line.uom}
                        initialBaseCost={Number(line.unit_cost)}
                        onChange={(c) => updateLine(i, { unit_cost: c == null ? "" : String(c) })}
                      />
                      <ItemDiscountInput
                        value={line.line_discount}
                        onChange={(v) => updateLine(i, { line_discount: v })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Diskon baris di atas sudah termasuk bagian diskon dokumen dari pencatatan sebelumnya. Diskon tambahan
              dokumen di bawah ditambahkan lagi di atasnya.
            </p>
          </div>

          <ReceiptDiscountSection totals={totals} extraDiscount={extraDiscount} onExtraChange={setExtraDiscount} />
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          <JournalPreviewPanel
            groups={[
              previousValue > 0 && [
                { label: "Balik jurnal sebelumnya — Akun Barang Diterima Belum Ditagih (debit)", resolved: defaultAccounts["inventory.goods_received_not_invoiced"], side: "debit" },
                { label: "Balik jurnal sebelumnya — Akun Persediaan (kredit)", resolved: defaultAccounts["inventory.raw_material"], side: "credit" },
              ],
              totals.total > 0 && [
                { label: "Jurnal baru — Akun Persediaan (debit)", resolved: defaultAccounts["inventory.raw_material"], side: "debit" },
                { label: "Jurnal baru — Akun Barang Diterima Belum Ditagih (kredit)", resolved: defaultAccounts["inventory.goods_received_not_invoiced"], side: "credit" },
              ],
            ]}
          />

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>Nilai sebelumnya</span>
              <span className="font-mono">Rp{previousValue.toLocaleString("id-ID")}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-slate-500">
              <span>Selisih</span>
              <span className={`font-mono ${delta > 0 ? "text-red-600" : delta < 0 ? "text-emerald-600" : ""}`}>
                {delta >= 0 ? "+" : "-"}Rp{Math.abs(delta).toLocaleString("id-ID")}
              </span>
            </div>
          </div>

          <ReceiptTotalsCard totals={totals} />

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={submitting || !revisable}>
              {submitting ? "Menyimpan..." : "Simpan Revisi"}
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
