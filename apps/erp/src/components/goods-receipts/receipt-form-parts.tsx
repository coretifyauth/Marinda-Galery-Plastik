"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ReceiptTotals } from "@/lib/goods-receipts/calc";

const rp = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

/** Diskon item (Rupiah) untuk 1 baris barang masuk -- jumlah semua baris otomatis jadi bagian diskon dokumen. */
export function ItemDiscountInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-slate-500">Diskon item</span>
      <Input
        type="number"
        min="0"
        step="any"
        placeholder="Rp (opsional)"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-36"
      />
    </div>
  );
}

/**
 * Diskon pembelian: bagian otomatis (jumlah diskon item) + diskon tambahan level dokumen. Total diskon
 * dokumen gak bisa lebih kecil dari jumlah diskon item karena bagian otomatisnya tidak bisa diubah.
 */
export function ReceiptDiscountSection({
  totals,
  extraDiscount,
  onExtraChange,
}: {
  totals: ReceiptTotals;
  extraDiscount: string;
  onExtraChange: (value: string) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="mb-3 text-sm font-medium text-black">Diskon Pembelian</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="item_discount_total">Diskon item (otomatis)</Label>
          <Input
            id="item_discount_total"
            readOnly
            value={totals.itemDiscountTotal.toLocaleString("id-ID")}
            className="bg-slate-50 font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="discount_amount">Diskon tambahan dokumen (opsional)</Label>
          <Input
            id="discount_amount"
            type="number"
            min="0"
            step="any"
            placeholder="mis. 50000"
            value={extraDiscount}
            onChange={(e) => onExtraChange(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="discount_total">Total diskon dokumen</Label>
          <Input
            id="discount_total"
            readOnly
            value={totals.totalDiscount.toLocaleString("id-ID")}
            className="bg-slate-50 font-mono"
          />
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Diskon item diisi di tiap baris barang dan otomatis dijumlah ke sini. Diskon tambahan dibagi ke semua baris
        sebanding nilainya. Potongan ini mengurangi nilai barang masuk — tanpa jurnal diskon terpisah.
      </p>
    </div>
  );
}

export function ReceiptTotalsCard({ totals }: { totals: ReceiptTotals }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>Subtotal</span>
        <span className="font-mono">{rp(totals.subtotal)}</span>
      </div>
      {totals.totalDiscount > 0 && (
        <div className="flex items-center justify-between text-sm text-emerald-600">
          <span>Diskon</span>
          <span className="font-mono">-{rp(totals.totalDiscount)}</span>
        </div>
      )}
      <p className="mt-2 text-sm text-slate-500">Nilai Barang Masuk</p>
      <p className="mt-1 font-mono text-2xl text-black">{rp(totals.total)}</p>
    </div>
  );
}
