import type { GoodsReceiptNote } from "@/lib/goods-receipts/schema";
import { formatStockBreakdown } from "@/lib/stock-display";

type ReceiptLine = GoodsReceiptNote["goods_note_lines"][number];

const rupiah = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 2 });
const round2 = (n: number) => Math.round(n * 100) / 100;

// qty & unit_cost di DB SELALU satuan dasar (konversi satuan terjadi di UI sebelum RPC) --
// jadi nilai baris = qty x unit_cost, diskon baris dikurangkan terpisah (goods_note_lines.discount_amount).
const lineGross = (l: ReceiptLine) => round2(l.qty * l.unit_cost);
const lineNet = (l: ReceiptLine) => round2(lineGross(l) - (l.discount_amount ?? 0));

/** Satuan di atas satuan dasar (faktor > 1), urut dari kecil ke besar. */
function upperUnits(l: ReceiptLine) {
  return (l.items.item_units ?? [])
    .filter((u) => u.conversion_factor > 1)
    .sort((a, b) => a.conversion_factor - b.conversion_factor);
}

export function receiptLinesTotals(lines: ReceiptLine[]) {
  const gross = round2(lines.reduce((s, l) => s + lineGross(l), 0));
  const discount = round2(lines.reduce((s, l) => s + (l.discount_amount ?? 0), 0));
  return { gross, discount, net: round2(gross - discount) };
}

function QtyCell({ line }: { line: ReceiptLine }) {
  const units = upperUnits(line);
  if (units.length === 0) {
    return (
      <>
        {line.qty} {line.items.uom}
      </>
    );
  }
  return (
    <>
      <div>{formatStockBreakdown(line.qty, line.items.uom, units)}</div>
      <div className="text-xs text-slate-400">= {line.qty} {line.items.uom}</div>
    </>
  );
}

/**
 * Tabel baris barang masuk. `detail` = lengkap (harga per satuan atas + diskon + total
 * akumulasi); `compact` = ringkas buat sel daftar Barang Masuk.
 */
export function ReceiptLinesTable({
  lines,
  variant,
  billAmount,
}: {
  lines: ReceiptLine[];
  variant: "detail" | "compact";
  billAmount?: number;
}) {
  const totals = receiptLinesTotals(lines);

  if (variant === "compact") {
    return (
      <table className="w-full min-w-[320px] border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-[10px] font-medium uppercase text-slate-400">
            <th className="py-1 pr-3 font-medium">Barang</th>
            <th className="py-1 pr-3 text-right font-medium">Qty</th>
            <th className="py-1 pr-3 text-right font-medium">Harga</th>
            <th className="py-1 text-right font-medium">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-b border-slate-100 last:border-0 align-top">
              <td className="py-1 pr-3 text-black">{l.items.name}</td>
              <td className="py-1 pr-3 text-right">
                <QtyCell line={l} />
              </td>
              <td className="py-1 pr-3 text-right font-mono">{rupiah(l.unit_cost)}</td>
              <td className="py-1 text-right font-mono">{rupiah(lineNet(l))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const extra = billAmount != null ? round2(billAmount - totals.net) : 0;

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
          <th className="px-4 py-2">Item</th>
          <th className="px-4 py-2 text-right">Qty Diterima</th>
          <th className="px-4 py-2 text-right">Harga / Satuan Dasar</th>
          <th className="px-4 py-2 text-right">Harga Satuan Atas</th>
          <th className="px-4 py-2 text-right">Diskon</th>
          <th className="px-4 py-2 text-right">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => {
          const units = upperUnits(l);
          return (
            <tr key={l.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
              <td className="px-4 py-2 font-medium text-black">
                {l.items.name} <span className="font-normal text-slate-400">({l.items.uom})</span>
              </td>
              <td className="px-4 py-2 text-right font-mono">
                <QtyCell line={l} />
              </td>
              <td className="px-4 py-2 text-right font-mono">
                {rupiah(l.unit_cost)}
                <div className="text-xs text-slate-400">/ {l.items.uom}</div>
              </td>
              <td className="px-4 py-2 text-right font-mono">
                {units.length === 0 ? (
                  <span className="text-slate-300">—</span>
                ) : (
                  units.map((u) => (
                    <div key={u.unit_label}>
                      {rupiah(round2(l.unit_cost * u.conversion_factor))}
                      <span className="text-xs text-slate-400">
                        {" "}
                        / {u.unit_label} (×{u.conversion_factor.toLocaleString("id-ID")})
                      </span>
                    </div>
                  ))
                )}
              </td>
              <td className="px-4 py-2 text-right font-mono">
                {(l.discount_amount ?? 0) > 0 ? `− ${rupiah(l.discount_amount)}` : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-2 text-right font-mono font-medium text-black">{rupiah(lineNet(l))}</td>
            </tr>
          );
        })}
        {lines.length === 0 && (
          <tr>
            <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
              Belum ada baris item.
            </td>
          </tr>
        )}
      </tbody>
      {lines.length > 0 && (
        <tfoot className="text-sm">
          <tr className="border-t border-slate-200 bg-slate-50/60">
            <td colSpan={5} className="px-4 py-1.5 text-right text-slate-500">
              Subtotal Barang
            </td>
            <td className="px-4 py-1.5 text-right font-mono">{rupiah(totals.gross)}</td>
          </tr>
          {totals.discount > 0 && (
            <tr className="bg-slate-50/60">
              <td colSpan={5} className="px-4 py-1.5 text-right text-slate-500">
                Total Diskon
              </td>
              <td className="px-4 py-1.5 text-right font-mono">− {rupiah(totals.discount)}</td>
            </tr>
          )}
          <tr className="bg-slate-50/60 font-semibold text-black">
            <td colSpan={5} className="px-4 py-1.5 text-right">
              Total Barang
            </td>
            <td className="px-4 py-1.5 text-right font-mono">{rupiah(totals.net)}</td>
          </tr>
          {billAmount != null && extra !== 0 && (
            <tr className="bg-slate-50/60">
              <td colSpan={5} className="px-4 py-1.5 text-right text-slate-500">
                PPN &amp; biaya tambahan
              </td>
              <td className="px-4 py-1.5 text-right font-mono">{rupiah(extra)}</td>
            </tr>
          )}
          {billAmount != null && (
            <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-black">
              <td colSpan={5} className="px-4 py-2 text-right">
                Total Tagihan
              </td>
              <td className="px-4 py-2 text-right font-mono">{rupiah(billAmount)}</td>
            </tr>
          )}
        </tfoot>
      )}
    </table>
  );
}
