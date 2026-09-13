"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ItemUnit } from "@/lib/item-units/schema";

export type UomQtyChange = {
  unit: ItemUnit;
  /** Qty di satuan yang dipilih user (bukan satuan dasar). */
  qty: number;
  /** qty x conversion_factor -- ini yang dikirim ke RPC transaksi (qty_issued/qty_ordered). */
  baseQty: number;
  /** unit.price / conversion_factor -- harga per satuan dasar, buat RPC yang minta unit_price base (mis. create_order). */
  basePrice: number;
  /** qty x unit.price -- nominal baris ini di satuan yang dipilih. */
  amount: number;
};

type Props = {
  /** Baris item_units yang SUDAH difilter cuma yang punya price (units.length wajib > 0, dicek parent). */
  units: ItemUnit[];
  disabled?: boolean;
  onChange: (change: UomQtyChange | null) => void;
};

/**
 * Pilih 1 satuan (yang punya harga) + qty, harga muncul otomatis dari item_units.price --
 * pola sama pemilih satuan di apps/pos (bukan MultiUomQtyInput yang isi qty campur beberapa
 * satuan sekaligus). Dipakai di form sisi jual (Sales Order, Goods Issue) supaya harga gak
 * lagi diketik manual. Ref: docs/domain/inventory.md submodule "Satuan Jual & Harga".
 */
export function UomPriceQtyInput({ units, disabled, onChange }: Props) {
  const ordered = [...units].sort((a, b) => Number(b.is_base) - Number(a.is_base));
  const [unitId, setUnitId] = useState(ordered[0]?.id ?? "");
  const [qty, setQty] = useState("");

  const selectedUnit = ordered.find((u) => u.id === unitId) ?? ordered[0];

  function emit(nextUnitId: string, nextQty: string) {
    setUnitId(nextUnitId);
    setQty(nextQty);
    const unit = ordered.find((u) => u.id === nextUnitId);
    const qtyNum = Number(nextQty);
    const price = unit?.price ?? 0;
    if (!unit || nextQty.trim() === "" || Number.isNaN(qtyNum) || qtyNum <= 0) {
      onChange(null);
      return;
    }
    onChange({
      unit,
      qty: qtyNum,
      baseQty: qtyNum * unit.conversion_factor,
      basePrice: price / unit.conversion_factor,
      amount: qtyNum * price,
    });
  }

  // Quick overview -- barang yang sama sering punya >1 satuan jual dengan harga katalog
  // masing-masing (mis. pcs/lusin/bal) yang gak selalu proporsional 1 sama lain (bisa ada
  // diskon per satuan lebih besar). Begitu 1 satuan dipilih, tampilin harga katalog satuan
  // LAIN buat barang yang sama, biar user gampang sadar kalau salah pilih satuan.
  const otherUnits = ordered.filter((u) => u.id !== selectedUnit?.id && u.price != null);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min="0"
          step="any"
          placeholder="0"
          disabled={disabled}
          value={qty}
          onChange={(e) => emit(unitId, e.target.value)}
          className="w-24"
        />
        {ordered.length > 1 ? (
          <Select
            value={unitId}
            disabled={disabled}
            onChange={(e) => emit(e.target.value, qty)}
            className="w-28"
          >
            {ordered.map((u) => (
              <option key={u.id} value={u.id}>
                {u.unit_label}
              </option>
            ))}
          </Select>
        ) : (
          <span className="w-28 truncate text-sm text-slate-500">{selectedUnit?.unit_label}</span>
        )}
        {selectedUnit && (
          <span className="whitespace-nowrap text-xs text-slate-400">
            @Rp{(selectedUnit.price ?? 0).toLocaleString("id-ID")}
          </span>
        )}
      </div>
      {otherUnits.length > 0 && (
        <p className="pl-26 text-xs text-slate-400">
          Satuan lain:{" "}
          {otherUnits
            .map((u) => `Rp${(u.price ?? 0).toLocaleString("id-ID")}/${u.unit_label}`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}
