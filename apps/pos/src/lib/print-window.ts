/** window.open()+window.print() struk thermal -- pola sama print-window ERP
 * (apps/erp/src/lib/print/print-window.ts, dipakai label barcode item_units), TAPI
 * duplikat lokal karena belum ada shared package antar app (tech-stack-decisions.md,
 * lihat gimana stock-display.ts juga diduplikasi). Style-nya beda: lebar sempit +
 * monospace, niru struk kasir asli, bukan dokumen A4.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function rp(n: number): string {
  return `Rp${Math.round(n).toLocaleString("id-ID")}`;
}

export type ReceiptLine = { name: string; uom: string; qty: number; unitPrice: number; amount: number };
export type ReceiptExtraLine = { label: string; amount: number };

export type ReceiptData = {
  companyName: string | null;
  sourceRef: string;
  dateTime: string;
  customerName: string | null;
  lines: ReceiptLine[];
  extraLines: ReceiptExtraLine[];
  taxAmount: number;
  taxRate: number | null;
  subtotal: number;
  total: number;
  paymentLabel: string;
  cashReceived: number | null;
  change: number | null;
};

export function buildReceiptHtml(data: ReceiptData): string {
  const lineRows = data.lines
    .map(
      (l) => `
      <div class="row"><span>${escapeHtml(l.name)}</span></div>
      <div class="row sub"><span>${l.qty} ${escapeHtml(l.uom)} x ${rp(l.unitPrice)}</span><span>${rp(l.amount)}</span></div>`
    )
    .join("");

  const extraRows = data.extraLines
    .map((l) => `<div class="row"><span>${escapeHtml(l.label)}</span><span>${rp(l.amount)}</span></div>`)
    .join("");

  return `
    <div class="center">
      ${data.companyName ? `<div class="bold">${escapeHtml(data.companyName)}</div>` : ""}
      <div class="meta">${escapeHtml(data.dateTime)}</div>
      <div class="meta">${escapeHtml(data.sourceRef)}</div>
    </div>
    <hr />
    ${lineRows}
    <hr />
    <div class="row"><span>Subtotal</span><span>${rp(data.subtotal)}</span></div>
    ${extraRows}
    ${data.taxAmount > 0 ? `<div class="row"><span>PPN${data.taxRate != null ? ` (${data.taxRate}%)` : ""}</span><span>${rp(data.taxAmount)}</span></div>` : ""}
    <hr />
    <div class="row bold total"><span>Total</span><span>${rp(data.total)}</span></div>
    <div class="row"><span>Bayar (${escapeHtml(data.paymentLabel)})</span><span>${data.cashReceived != null ? rp(data.cashReceived) : "-"}</span></div>
    ${data.change != null ? `<div class="row"><span>Kembalian</span><span>${rp(data.change)}</span></div>` : ""}
    ${data.customerName ? `<div class="meta" style="margin-top:6px">Pelanggan: ${escapeHtml(data.customerName)}</div>` : ""}
    <div class="center meta" style="margin-top:10px">Terima kasih!</div>
  `;
}

export function printReceipt(sourceRef: string, bodyHtml: string): boolean {
  const printWindow = window.open("", "_blank", "width=360,height=640");
  if (!printWindow) return false;
  printWindow.document.write(`<!doctype html>
<html>
<head>
<title>Struk — ${escapeHtml(sourceRef)}</title>
<style>
  body { font-family: "Courier New", monospace; padding: 16px; color: #111; font-size: 12px; width: 280px; }
  hr { border: none; border-top: 1px dashed #94a3b8; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row.sub { color: #475569; font-size: 11px; margin-bottom: 3px; }
  .center { text-align: center; }
  .bold { font-weight: 700; }
  .meta { color: #475569; font-size: 11px; }
  .total { font-size: 13px; }
</style>
</head>
<body>
${bodyHtml}
<script>window.onload = function () { window.print(); };</script>
</body>
</html>`);
  printWindow.document.close();
  return true;
}

// Struk digital -- keputusan (2026-08-16): wa.me link manual, BUKAN WhatsApp Business API
// resmi (butuh akun berbayar + approval, di luar scope toko kecil). Kasir kirim manual,
// teks struk udah disiapin di clipboard-nya link ini.
export function buildWhatsappReceiptText(data: ReceiptData): string {
  const lines: string[] = [];
  if (data.companyName) lines.push(`*${data.companyName}*`);
  lines.push(data.dateTime);
  lines.push(data.sourceRef);
  lines.push("------------------------------");
  for (const l of data.lines) {
    lines.push(l.name);
    lines.push(`  ${l.qty} ${l.uom} x ${rp(l.unitPrice)} = ${rp(l.amount)}`);
  }
  lines.push("------------------------------");
  lines.push(`Subtotal: ${rp(data.subtotal)}`);
  for (const l of data.extraLines) lines.push(`${l.label}: ${rp(l.amount)}`);
  if (data.taxAmount > 0) lines.push(`PPN: ${rp(data.taxAmount)}`);
  lines.push(`Total: ${rp(data.total)}`);
  lines.push(`Bayar (${data.paymentLabel}): ${data.cashReceived != null ? rp(data.cashReceived) : "-"}`);
  if (data.change != null) lines.push(`Kembalian: ${rp(data.change)}`);
  lines.push("");
  lines.push("Terima kasih!");
  return lines.join("\n");
}

// Nomor kosong -> https://wa.me/?text=... (WhatsApp buka picker kontak, gak perlu nomor
// spesifik) -- dipakai kalau customer.contact kosong/bukan nomor telepon.
export function buildWhatsappLink(phone: string | null, text: string): string {
  const digits = phone ? phone.replace(/\D/g, "") : "";
  const normalized = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
  const base = normalized ? `https://wa.me/${normalized}` : "https://wa.me/";
  return `${base}?text=${encodeURIComponent(text)}`;
}
