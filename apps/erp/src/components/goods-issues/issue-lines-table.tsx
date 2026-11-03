import type { GoodsIssue } from "@/lib/goods-issues/schema";
import { formatStockBreakdown } from "@/lib/stock-display";

type IssueLine = GoodsIssue["goods_note_lines"][number];

const rupiah = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 2 });

/** Satuan di atas satuan dasar (faktor > 1), urut dari kecil ke besar. */
function upperUnits(l: Pick<IssueLine, "items">) {
  return (l.items.item_units ?? [])
    .filter((u) => u.conversion_factor > 1)
    .sort((a, b) => a.conversion_factor - b.conversion_factor);
}

/** Qty dalam kombinasi satuan (mis. "1 box, 2 pack, 4 pcs") + total satuan dasar di bawahnya. */
export function QtyCell({ line }: { line: Pick<IssueLine, "qty" | "items"> }) {
  const units = upperUnits(line);
  if (units.length === 0) {
    return (
      <>
        {line.qty} {line.items.uom}
      </>
    );
  }
  return <>{formatStockBreakdown(line.qty, line.items.uom, units)}</>;
}

/**
 * Tabel baris barang keluar untuk sel daftar Barang Keluar — padanan `ReceiptLinesTable` (variant compact) di Barang Masuk.
 * Sisi nilai memakai HPP (bukan harga jual): harga jual per baris tidak selalu tersimpan.
 */
export function IssueLinesTable({ lines }: { lines: IssueLine[] }) {
  return (
    <table className="w-full min-w-[320px] border-collapse text-xs">
      <thead>
        <tr className="border-b border-slate-200 text-left text-[10px] font-medium uppercase text-slate-400">
          <th className="py-1 pr-3 font-medium">Barang</th>
          <th className="py-1 pr-3 text-right font-medium">Qty</th>
          <th className="py-1 pr-3 text-right font-medium">HPP / Unit</th>
          <th className="py-1 text-right font-medium">Total HPP</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id} className="border-b border-slate-100 last:border-0 align-top">
            <td className="py-1 pr-3 text-black">{l.items.name}</td>
            <td className="py-1 pr-3 text-right">
              <QtyCell line={l} />
            </td>
            <td className="py-1 pr-3 text-right font-mono">{rupiah(l.total_cost / l.qty)}</td>
            <td className="py-1 text-right font-mono">{rupiah(l.total_cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
