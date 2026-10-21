"use client";

import type { ItemUnit } from "@/lib/item-units/schema";
import { formatStockBreakdown } from "@/lib/stock-display";
import { MultiUomQtyInput } from "@/components/ui/multi-uom-qty-input";

type Props = {
  itemId: string;
  /** items.uom -- satuan dasar. */
  baseUom: string;
  /** Satuan milik item ini (boleh kosong -- tetap dapat 1 kolom satuan dasar). */
  units: ItemUnit[];
  /** Batas atas dalam satuan dasar (sisa yang masih boleh diklaim). */
  maxBaseQty: number;
  /** Nilai saat ini dalam satuan dasar ("" kalau kosong) -- cuma dipakai buat validasi batas. */
  baseQty: string;
  /** Prefill dalam satuan dasar (mis. sisa SO yang otomatis terisi). */
  initialBaseQty?: string;
  onChange: (baseQty: string) => void;
};

/**
 * Input qty untuk baris yang qty-nya dibatasi dokumen asal (retur, tukar barang, pengiriman SO).
 * User ngisi per satuan (mis. 1 dus + 3 pcs), konversi ke satuan dasar dilakukan di sini --
 * form induk dan RPC tetap terima qty satuan dasar apa adanya. Batas ditampilin dalam satuan
 * campuran juga ("Maks 1 dus, 4 pcs"), jadi user gak perlu ngitung manual.
 */
export function QtyByUnitField({ itemId, baseUom, units, maxBaseQty, baseQty, initialBaseQty, onChange }: Props) {
  const entered = Number(baseQty);
  const overLimit = baseQty.trim() !== "" && !Number.isNaN(entered) && entered > maxBaseQty + 0.0005;

  return (
    <div className="flex flex-col gap-1">
      {/* key ikut daftar satuan: begitu item_units selesai dimuat, input dibangun ulang dari prefill
          (kalau gak, state-nya nyangkut di id satuan dasar sintetis dan tampilannya beda dari nilai induk). */}
      <MultiUomQtyInput
        key={`${itemId}:${units.map((u) => u.id).join(",")}`}
        units={units}
        baseUom={baseUom}
        initialBaseQty={initialBaseQty}
        onChange={(c) => onChange(c.baseQty)}
      />
      <span className={`text-xs ${overLimit ? "text-red-600" : "text-slate-400"}`}>
        {overLimit ? "Melebihi sisa — " : ""}Maks {formatStockBreakdown(maxBaseQty, baseUom, units)}
      </span>
    </div>
  );
}
