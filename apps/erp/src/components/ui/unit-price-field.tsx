"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ItemUnit } from "@/lib/item-units/schema";

type Props = {
  /** Satuan milik item ini (boleh kosong -- cuma satuan dasar). */
  units: ItemUnit[];
  /** items.uom -- satuan dasar. */
  baseUom: string;
  /** Harga awal per SATUAN DASAR (mis. harga berlaku saat revisi). */
  initialBaseCost?: number;
  /** Dipanggil dengan harga per satuan dasar, atau null kalau kosong/tidak valid. */
  onChange: (baseCost: number | null) => void;
};

const SYNTHETIC_BASE_ID = "__base__";

/**
 * Harga saja (tanpa qty) per satuan yang dipilih -- dipakai revisi barang masuk, di mana qty gak boleh
 * berubah. Harga diketik per satuan pilihan (mis. per dus), dikonversi ke harga per satuan dasar
 * lewat conversion_factor. Nilai 0 valid (belum tahu harga).
 */
export function UnitPriceField({ units, baseUom, initialBaseCost, onChange }: Props) {
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

  const [unitId, setUnitId] = useState(ordered[0]?.id ?? "");
  const [price, setPrice] = useState(initialBaseCost != null ? String(initialBaseCost) : "");

  function emit(nextUnitId: string, nextPrice: string) {
    setUnitId(nextUnitId);
    setPrice(nextPrice);
    const unit = ordered.find((u) => u.id === nextUnitId);
    const num = Number(nextPrice);
    if (!unit || nextPrice.trim() === "" || Number.isNaN(num) || num < 0) {
      onChange(null);
      return;
    }
    onChange(num / unit.conversion_factor);
  }

  const selected = ordered.find((u) => u.id === unitId) ?? ordered[0];
  const num = Number(price);
  const showBreakdown = price.trim() !== "" && !Number.isNaN(num) && num > 0 && ordered.length > 1;
  const baseCost = showBreakdown ? num / selected.conversion_factor : 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min="0"
          step="any"
          placeholder="Harga/satuan"
          value={price}
          onChange={(e) => emit(unitId, e.target.value)}
          className="w-32"
        />
        {ordered.length > 1 ? (
          <Select value={unitId} onChange={(e) => emit(e.target.value, price)} className="w-24">
            {ordered.map((u) => (
              <option key={u.id} value={u.id}>
                per {u.unit_label}
              </option>
            ))}
          </Select>
        ) : (
          <span className="w-24 truncate text-sm text-slate-500">per {selected?.unit_label}</span>
        )}
      </div>
      {showBreakdown && (
        <p className="text-xs text-slate-400">
          ≈{" "}
          {ordered
            .filter((u) => u.id !== selected.id)
            .map((u) => `Rp${Math.round(baseCost * u.conversion_factor).toLocaleString("id-ID")}/${u.unit_label}`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}
