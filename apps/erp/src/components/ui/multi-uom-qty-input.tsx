"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import type { ItemUnit } from "@/lib/item-units/schema";

export type MultiUomChange = {
  /** Total qty di satuan dasar (items.uom), sudah dijumlah dari semua satuan yang diisi. "" kalau semua kosong. */
  baseQty: string;
  /** Sum(qty_input x item_units.price) lintas satuan yang punya price. null kalau gak ada satuan berharga yang diisi. */
  amount: number | null;
};

type Props = {
  /** Baris item_units milik 1 item (boleh 0 baris). */
  units: ItemUnit[];
  /** items.uom -- dipakai sebagai fallback label kalau item belum punya baris is_base di item_units. */
  baseUom: string;
  /** Prefill breakdown satuan dasar, mis. qty sisa PO yang otomatis muncul di form goods receipt. */
  initialBaseQty?: string;
  disabled?: boolean;
  onChange: (change: MultiUomChange) => void;
};

const SYNTHETIC_BASE_ID = "__base__";

/**
 * Input qty simultan per satuan (pcs, pack, box, dst) untuk 1 item -- dijumlah ke qty
 * satuan dasar via item_units.conversion_factor sebelum dilaporkan ke parent (RPC tetap
 * terima qty satuan dasar apa adanya, 0 perubahan -- lihat memory/domain/inventory.md
 * submodule "Satuan Jual & Harga"). Item tanpa item_units tetap dapat 1 kolom (satuan
 * dasar sintetis), jadi gak butuh cabang UI terpisah buat kasus "belum ada satuan".
 */
export function MultiUomQtyInput({ units, baseUom, initialBaseQty, disabled, onChange }: Props) {
  const hasBaseRow = units.some((u) => u.is_base);
  const ordered = hasBaseRow
    ? [...units].sort((a, b) => Number(b.is_base) - Number(a.is_base))
    : [
        {
          id: SYNTHETIC_BASE_ID,
          item_id: units[0]?.item_id ?? "",
          unit_label: baseUom,
          conversion_factor: 1,
          price: null,
          is_base: true,
          barcode: null,
        } as ItemUnit,
        ...units,
      ];

  const [breakdown, setBreakdown] = useState<Record<string, string>>(() => {
    if (!initialBaseQty) return {};
    const baseUnit = ordered.find((u) => u.is_base);
    return baseUnit ? { [baseUnit.id]: initialBaseQty } : {};
  });

  function emit(next: Record<string, string>) {
    setBreakdown(next);
    let baseQty = 0;
    let amount = 0;
    let hasQty = false;
    let hasAmount = false;
    for (const u of ordered) {
      const raw = next[u.id];
      if (!raw || raw.trim() === "") continue;
      const qty = Number(raw);
      if (Number.isNaN(qty)) continue;
      hasQty = true;
      baseQty += qty * u.conversion_factor;
      if (u.price != null) {
        amount += qty * u.price;
        hasAmount = true;
      }
    }
    onChange({ baseQty: hasQty ? String(baseQty) : "", amount: hasAmount ? amount : null });
  }

  const total = ordered.reduce((sum, u) => {
    const raw = breakdown[u.id];
    const qty = raw ? Number(raw) : NaN;
    return Number.isNaN(qty) ? sum : sum + qty * u.conversion_factor;
  }, 0);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {ordered.map((u) => (
          <div key={u.id} className="flex w-20 flex-col gap-0.5">
            <Input
              type="number"
              min="0"
              step="any"
              placeholder="0"
              disabled={disabled}
              value={breakdown[u.id] ?? ""}
              onChange={(e) => emit({ ...breakdown, [u.id]: e.target.value })}
            />
            <span className="truncate text-[11px] text-slate-500">{u.unit_label}</span>
          </div>
        ))}
      </div>
      {ordered.length > 1 && total > 0 && (
        <span className="text-xs text-slate-400">= {total} {baseUom}</span>
      )}
    </div>
  );
}
