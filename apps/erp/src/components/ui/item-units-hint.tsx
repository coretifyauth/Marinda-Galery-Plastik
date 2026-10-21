import type { ItemUnit } from "@/lib/item-units/schema";

type Props = {
  /** items.uom -- satuan dasar. */
  baseUom: string;
  /** Satuan milik item ini (boleh kosong -- cuma tampil satuan dasar). */
  units: ItemUnit[];
};

/**
 * Keterangan satuan di bawah nama item: satuan dasar + konversi satuan lain
 * ("Satuan dasar: pcs · 1 pack = 12 pcs · 1 dus = 144 pcs"), biar user tau isi tiap kolom
 * satuan tanpa nebak.
 */
export function ItemUnitsHint({ baseUom, units }: Props) {
  const larger = units
    .filter((u) => !u.is_base && u.conversion_factor > 1)
    .sort((a, b) => a.conversion_factor - b.conversion_factor);

  return (
    <span className="text-xs text-slate-400">
      Satuan dasar: {baseUom}
      {larger.map((u) => ` · 1 ${u.unit_label} = ${u.conversion_factor} ${baseUom}`).join("")}
    </span>
  );
}
