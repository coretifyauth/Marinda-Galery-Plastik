import type { JournalLeg } from "@/components/ui/journal-preview-panel";
import type { ResolvedAccount } from "@/lib/default-accounts/schema";
import { roundingBounds, type PaymentPreview } from "@/lib/payments/rounding";

const rp = (n: number) => `Rp${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;

/** Keterangan di bawah field "Jumlah dibayar" form pelunasan AR/AP -- apa yang bakal dicatat
 * record_payment untuk nominal yang diketik (lunas / lunas dengan pembulatan / cicilan / ditolak).
 * Konsep: docs/domain/accounts-payable.md submodule "Selisih Pembulatan Pelunasan". */
export function PaymentPreviewNote({
  preview,
  remaining,
  unit,
}: {
  preview: PaymentPreview;
  remaining: number;
  unit: number;
}) {
  const { floor, ceil } = roundingBounds(remaining, unit);
  const hint =
    floor !== ceil ? `Pelunasan dengan pembulatan (satuan ${rp(unit)}): ${rp(floor)} atau ${rp(ceil)}.` : null;

  let message: string | null = null;
  let tone = "text-slate-500";
  switch (preview.kind) {
    case "exact":
      message = "Melunasi penuh.";
      break;
    case "rounded":
      message =
        preview.gain > 0
          ? `Lunas dengan pembulatan — selisih ${rp(preview.gain)} dicatat ke Pendapatan Selisih Pembulatan.`
          : `Lunas dengan pembulatan — selisih ${rp(-preview.gain)} dicatat ke Beban Selisih Pembulatan.`;
      tone = "text-emerald-700";
      break;
    case "partial":
      message = `Cicilan — sisa tagihan setelah ini ${rp(preview.remainingAfter)}.`;
      break;
    case "overpay":
      message = `Melebihi sisa tagihan ${rp(remaining)} — ditolak.`;
      tone = "text-red-600";
      break;
    case "invalid":
      message = preview.message;
      tone = "text-red-600";
      break;
  }

  if (!message && !hint) return null;
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {message && <p className={tone}>{message}</p>}
      {hint && <p className="text-slate-500">{hint}</p>}
    </div>
  );
}

/** Leg jurnal selisih pembulatan buat <JournalPreviewPanel> -- null kalau gak ada selisih. */
export function roundingLeg(
  preview: PaymentPreview,
  defaultAccounts: Record<string, ResolvedAccount>
): JournalLeg | null {
  if (preview.kind !== "rounded" || preview.gain === 0) return null;
  return preview.gain > 0
    ? { label: "Pendapatan Selisih Pembulatan (kredit)", resolved: defaultAccounts["rounding.revenue"], side: "credit" }
    : { label: "Beban Selisih Pembulatan (debit)", resolved: defaultAccounts["rounding.expense"], side: "debit" };
}
