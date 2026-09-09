"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ItemUnit } from "@/lib/item-units/schema";

export type UnitCostQtyChange = {
  unit: ItemUnit;
  /** Qty di satuan yang dipilih user. */
  qty: number;
  /** Harga per satuan yang dipilih user -- SELALU diketik manual (bukan item_units.price,
   * itu harga jual ke customer, gak relevan buat harga beli dari supplier -- gak ada
   * "katalog harga beli" di skema ini). */
  unitCost: number;
  /** qty x conversion_factor -- dikirim ke RPC sebagai qty_ordered/qty_received. */
  baseQty: number;
  /** unitCost / conversion_factor -- dikirim ke RPC sebagai unit_cost_expected/unit_cost. */
  baseCost: number;
};

type Props = {
  /** Baris item_units milik 1 item (boleh 0 baris). */
  units: ItemUnit[];
  /** items.uom -- dipakai sebagai fallback label kalau item belum punya baris is_base di item_units. */
  baseUom: string;
  /** Prefill qty & harga di satuan dasar, mis. sisa PO yang otomatis muncul di form Goods Receipt. */
  initialBaseQty?: string;
  initialBaseCost?: string;
  disabled?: boolean;
  onChange: (change: UnitCostQtyChange | null) => void;
};

const SYNTHETIC_BASE_ID = "__base__";

/**
 * Pilih 1 satuan + qty + harga beli manual per satuan itu -- pola sama UomPriceQtyInput
 * (sisi jual), tapi harganya TETAP diketik manual, gak difilter/diambil dari item_units.price.
 * Dipakai di Purchase Order & Goods Receipt, gantiin MultiUomQtyInput (isi qty campur
 * beberapa satuan sekaligus) yang tadinya dipasang di 2 form ini. Ref: docs/domain/inventory.md
 * submodule "Satuan Jual & Harga".
 */
export function UnitCostQtyInput({
  units,
  baseUom,
  initialBaseQty,
  initialBaseCost,
  disabled,
  onChange,
}: Props) {
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
  const [qty, setQty] = useState(initialBaseQty ?? "");
  const [cost, setCost] = useState(initialBaseCost ?? "");

  const selectedUnit = ordered.find((u) => u.id === unitId) ?? ordered[0];

  function emit(nextUnitId: string, nextQty: string, nextCost: string) {
    setUnitId(nextUnitId);
    setQty(nextQty);
    setCost(nextCost);
    const unit = ordered.find((u) => u.id === nextUnitId);
    const qtyNum = Number(nextQty);
    const costNum = Number(nextCost);
    if (
      !unit ||
      nextQty.trim() === "" ||
      nextCost.trim() === "" ||
      Number.isNaN(qtyNum) ||
      Number.isNaN(costNum) ||
      qtyNum <= 0 ||
      costNum <= 0
    ) {
      onChange(null);
      return;
    }
    onChange({
      unit,
      qty: qtyNum,
      unitCost: costNum,
      baseQty: qtyNum * unit.conversion_factor,
      baseCost: costNum / unit.conversion_factor,
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min="0"
        step="any"
        placeholder="Qty"
        disabled={disabled}
        value={qty}
        onChange={(e) => emit(unitId, e.target.value, cost)}
        className="w-20"
      />
      {ordered.length > 1 ? (
        <Select
          value={unitId}
          disabled={disabled}
          onChange={(e) => emit(e.target.value, qty, cost)}
          className="w-24"
        >
          {ordered.map((u) => (
            <option key={u.id} value={u.id}>
              {u.unit_label}
            </option>
          ))}
        </Select>
      ) : (
        <span className="w-24 truncate text-sm text-slate-500">{selectedUnit?.unit_label}</span>
      )}
      <Input
        type="number"
        min="0"
        step="any"
        placeholder="Harga/satuan"
        disabled={disabled}
        value={cost}
        onChange={(e) => emit(unitId, qty, e.target.value)}
        className="w-28"
      />
    </div>
  );
}
