/** Tampilan bersama cetakan Kartu Stok (per barang di `items/[id]` dan semua barang di `inventory`).
 * Ditaruh sebagai <style> di dalam body karena `openPrintWindow` cuma menerima isi body; kelas
 * berprefiks `sc-` biar gak bentrok sama gaya dasar `print-window.ts`. Semua teks yang masuk
 * helper di sini di-escape di sini, jadi pemanggil cukup kirim string mentah.
 */
import { escapeHtml } from "./print-window";

const STYLES = `<style>
  @page { size: A4; margin: 10mm 10mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { padding: 0; font-size: 12px; }
  .letterhead { margin-bottom: 8px; padding-bottom: 8px; }
  .letterhead img { max-height: 40px !important; }
  .sc-header { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; margin-bottom: 8px; }
  .sc-title { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: #0f172a; }
  .sc-subtitle { margin-top: 1px; font-size: 13px; font-weight: 600; color: #475569; }
  .sc-meta { text-align: right; font-size: 10px; line-height: 1.5; color: #64748b; }
  .sc-meta strong { color: #1e293b; font-weight: 600; }
  .sc-summary { display: flex; gap: 8px; margin-bottom: 4px; }
  .sc-card { flex: 1; padding: 5px 10px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc; }
  .sc-card.accent { background: #1e293b; border-color: #1e293b; color: #fff; }
  .sc-card-label { font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: #64748b; }
  .sc-card.accent .sc-card-label { color: #cbd5e1; }
  .sc-card-value { margin-top: 1px; font-size: 14px; font-weight: 700; }
  .sc-section { margin: 10px 0 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #334155; }
  table.sc-table { margin-top: 6px; font-size: 11px; }
  .sc-section + table.sc-table { margin-top: 0; }
  .sc-table thead { display: table-header-group; }
  .sc-table th { padding: 5px 8px; border: none; background: #1e293b; color: #fff; font-size: 9px; letter-spacing: 0.06em; }
  .sc-table td { padding: 3px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .sc-table tbody tr:nth-child(even) td { background: #f8fafc; }
  .sc-table tr { page-break-inside: avoid; }
  .sc-table tfoot td { padding: 5px 8px; border-top: 2px solid #1e293b; border-bottom: none; background: #fff; font-weight: 700; }
  .sc-table .sc-no { width: 24px; text-align: center; color: #94a3b8; }
  .sc-name { font-weight: 600; color: #0f172a; }
  .sc-qty { font-weight: 700; }
  .sc-zero { font-weight: 400; color: #94a3b8; }
  .sc-in { color: #15803d; font-weight: 600; }
  .sc-out { color: #b91c1c; font-weight: 600; }
  .sc-ref { padding: 0 5px; border-radius: 999px; background: #e2e8f0; color: #475569; font-family: Consolas, monospace; font-size: 9px; }
  .sc-prices { display: flex; flex-wrap: wrap; gap: 0 14px; }
  .sc-price-row { display: flex; gap: 4px; white-space: nowrap; }
  .sc-price-row span:first-child { color: #64748b; }
  .sc-price-row span:last-child { font-weight: 600; color: #0f172a; }
  .sc-empty { padding: 12px 8px; text-align: center; color: #94a3b8; }
  .sc-footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 10px; padding-top: 5px; border-top: 1px solid #e2e8f0; font-size: 9px; color: #94a3b8; }
</style>`;

export function stockCardStyles(): string {
  return STYLES;
}

export function stockCardHeader(opts: {
  title: string;
  subtitle?: string;
  meta: { label: string; value: string }[];
}): string {
  const meta = opts.meta
    .map((m) => `<div>${escapeHtml(m.label)}: <strong>${escapeHtml(m.value)}</strong></div>`)
    .join("");
  return `
    <div class="sc-header">
      <div>
        <h1 class="sc-title">${escapeHtml(opts.title)}</h1>
        ${opts.subtitle ? `<div class="sc-subtitle">${escapeHtml(opts.subtitle)}</div>` : ""}
      </div>
      <div class="sc-meta">${meta}</div>
    </div>`;
}

export function stockCardSummary(cards: { label: string; value: string; accent?: boolean }[]): string {
  const html = cards
    .map(
      (c) => `<div class="sc-card${c.accent ? " accent" : ""}">
        <div class="sc-card-label">${escapeHtml(c.label)}</div>
        <div class="sc-card-value">${escapeHtml(c.value)}</div>
      </div>`
    )
    .join("");
  return `<div class="sc-summary">${html}</div>`;
}

/** Satu baris per satuan: label di kiri, nilai rata kanan (default format Rupiah; `format` buat qty). Kosong -> "-". */
export function stockCardPrices(
  prices: { label: string; price: number }[],
  format: (n: number) => string = (n) => `Rp${n.toLocaleString("id-ID")}`
): string {
  if (prices.length === 0) return "-";
  const rows = prices
    .map(
      (p) =>
        `<div class="sc-price-row"><span>${escapeHtml(p.label)}</span><span>${escapeHtml(format(p.price))}</span></div>`
    )
    .join("");
  return `<div class="sc-prices">${rows}</div>`;
}

export function stockCardFooter(printedAt: string): string {
  return `
    <div class="sc-footer">
      <span>Stok dan harga berlaku pada saat dicetak (${escapeHtml(printedAt)}). Harga yang tercantum adalah harga jual.</span>
      <span>Dicetak dari sistem ERP</span>
    </div>`;
}
