"use client";

import type { ChargeLineInput, ChargeType } from "@/lib/charge-lines/schema";
import { Select } from "./select";
import { Input } from "./input";
import { Button } from "./button";

/** Editor baris "kategori biaya tambahan" dinamis — dipakai di AP Bill, AR Invoice, dan Goods
 * Issue. Kategori dipilih dari katalog admin (`charge_categories`, bukan akun mentah), nominal
 * diinput bebas per transaksi (gak ada nilai default). */
export function ChargeLinesEditor({
  label,
  lines,
  chargeTypes,
  onChange,
}: {
  label: string;
  lines: ChargeLineInput[];
  chargeTypes: ChargeType[];
  onChange: (lines: ChargeLineInput[]) => void;
}) {
  const activeTypes = chargeTypes.filter((c) => !c.archived_at);

  function updateLine(index: number, patch: Partial<ChargeLineInput>) {
    onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addLine() {
    onChange([...lines, { category_id: "", amount: "" }]);
  }
  function removeLine(index: number) {
    onChange(lines.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-slate-500">{label}</span>
      {lines.length === 0 && (
        <p className="text-xs text-slate-400">Belum ada kategori tambahan.</p>
      )}
      {lines.map((line, i) => (
        <div key={i} className="grid grid-cols-[1fr_10rem_2.5rem] gap-2">
          <Select
            value={line.category_id}
            onChange={(e) => updateLine(i, { category_id: e.target.value })}
          >
            <option value="">Pilih kategori...</option>
            {activeTypes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            min="0"
            placeholder="0"
            value={line.amount}
            onChange={(e) => updateLine(i, { amount: e.target.value })}
          />
          <button
            type="button"
            onClick={() => removeLine(i)}
            className="text-slate-400 hover:text-red-600"
            aria-label="Hapus baris kategori"
          >
            ✕
          </button>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={addLine} className="w-fit">
        + Tambah Kategori
      </Button>
      {activeTypes.length === 0 && (
        <p className="text-xs text-amber-600">
          Belum ada kategori aktif — admin bisa setup di halaman Pengaturan &gt; Kategori & Pajak.
        </p>
      )}
    </div>
  );
}
