// Penanda "data tidak valid" buat dokumen yang sudah dibatalkan (tagihan, barang masuk) --
// sengaja mencolok: badge merah solid + baris list kemerahan dengan garis tepi & coretan.

export const cancelledRowClass =
  "bg-red-50 text-slate-400 line-through decoration-red-300 shadow-[inset_4px_0_0_0_#dc2626] hover:bg-red-100/70";

export function CancelledBadge({ label = "Dibatalkan" }: { label?: string }) {
  return (
    <span className="inline-block rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white no-underline">
      ✕ {label}
    </span>
  );
}

export function CancelledBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-lg border-2 border-red-600 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
    >
      ✕ DIBATALKAN — {children}
    </div>
  );
}
