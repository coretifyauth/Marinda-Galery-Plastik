/** Shared window.open()+window.print() helper -- bukan @media print di halaman ini, karena
 * native <dialog>/Modal gak konsisten diprint lintas browser (Firefox sering skip isi dialog
 * sama sekali pas print), dan trik "visibility:hidden semua elemen lain" gampang nyisain
 * halaman kosong. Window terpisah = gak ada chrome/dialog yang perlu disembunyiin sama sekali.
 * Pola sama yang dipakai label barcode item_units (apps/erp/src/app/(app)/items/[id]/view.tsx).
 */

// Interpolasi ke document.write() butuh escape manual (bukan JSX yang otomatis escape) --
// data transaksi (nama customer/supplier/item, deskripsi) itu master data yang user ketik
// bebas, jangan sampai jadi HTML/script injection ke window print.
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function openPrintWindow(title: string, bodyHtml: string): boolean {
  const printWindow = window.open("", "_blank", "width=800,height=1000");
  if (!printWindow) return false;
  printWindow.document.write(`<!doctype html>
<html>
<head>
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; padding: 32px; color: #1e293b; font-size: 13px; }
  h1 { margin: 0; font-size: 20px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
  th { font-size: 11px; text-transform: uppercase; color: #64748b; background: #f8fafc; }
  td.num, th.num { text-align: right; }
  .meta { color: #64748b; font-size: 12px; }
  .watermark {
    margin: 0 0 16px; padding: 8px 12px; border-radius: 6px;
    background: #fef2f2; color: #b91c1c; font-weight: 700; letter-spacing: 0.05em;
    text-transform: uppercase; text-align: center;
  }
  .total-row td { font-weight: 700; border-top: 2px solid #1e293b; border-bottom: none; }
  .letterhead {
    display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
    padding-bottom: 12px; border-bottom: 2px solid #1e293b;
  }
  .letterhead-name { font-size: 16px; font-weight: 700; }
  .letterhead-meta { font-size: 11px; color: #64748b; }
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

export type LetterheadCompany = { name: string; address: string | null; npwp: string | null; logo_url: string | null };

/** Kop surat -- ditaruh di atas body cetakan. Gak render apa pun kalau company null
 * (query company_settings gagal, harusnya gak pernah terjadi di kondisi normal -- baris
 * singleton-nya selalu ada sejak migration 0026). */
export function buildLetterheadHtml(company: LetterheadCompany | null): string {
  if (!company) return "";
  const logoImg = company.logo_url
    ? `<img src="${escapeHtml(company.logo_url)}" alt="" style="max-height:56px;max-width:140px;object-fit:contain;" />`
    : "";
  return `
    <div class="letterhead">
      ${logoImg}
      <div>
        <div class="letterhead-name">${escapeHtml(company.name)}</div>
        ${company.address ? `<div class="letterhead-meta">${escapeHtml(company.address)}</div>` : ""}
        ${company.npwp ? `<div class="letterhead-meta">NPWP: ${escapeHtml(company.npwp)}</div>` : ""}
      </div>
    </div>
  `;
}
