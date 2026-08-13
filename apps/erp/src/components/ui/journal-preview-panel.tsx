import Link from "next/link";
import type { ResolvedAccount } from "@/lib/default-accounts/schema";

export type JournalLeg = { label: string; resolved: ResolvedAccount | undefined; side?: "debit" | "credit" };
type LegInput = JournalLeg | false | null | undefined;

/** Ringkasan "akun apa aja yang kena jurnal" buat 1 form/modal transaksi —
 * ditaruh di atas section form, terpisah dari input yang user isi. Sumber
 * datanya sama persis dengan yang dulu dilempar ke <LockedAccountField>
 * (sekarang cuma hidden input, gak ada UI).
 *
 * `groups` = array per JURNAL TERPISAH (transaksi yang bikin >1 journal_entry
 * row, mis. create_goods_issue = jurnal invoice + jurnal HPP) — dipisah garis
 * pembatas, BUKAN cuma array leg flat. Tiap grup array leg, boleh isi entry
 * falsy (`cond && { label, resolved, side }`) buat leg kondisional. `side`
 * nentuin indent (kredit digeser ke kanan, niru gaya tulisan jurnal akuntansi
 * manual) — opsional, dikosongin kalau leg gak punya lawan yang jelas (mis.
 * akun 1 arah yang dipakai debit MAUPUN kredit gantian, kayak reklas Tukar
 * Barang AP yang akun-nya sama persis di 2 sisi). */
export function JournalPreviewPanel({ groups }: { groups: (LegInput[] | false | null | undefined)[] }) {
  const journals = groups
    .filter((g): g is LegInput[] => !!g)
    .map((g) => g.filter((leg): leg is JournalLeg => !!leg))
    .filter((g) => g.length > 0);
  if (journals.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Jurnal yang Terlibat
      </p>
      <div className="flex flex-col">
        {journals.map((journal, gi) => (
          <div
            key={gi}
            className={`flex flex-col gap-1.5 ${gi > 0 ? "mt-3 border-t border-slate-200 pt-3" : ""}`}
          >
            {journal.map((leg, li) => (
              <div
                key={li}
                className={`flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 ${
                  leg.side === "credit" ? "pl-6" : ""
                }`}
              >
                <span className="text-sm text-slate-600">{leg.label}</span>
                {leg.resolved ? (
                  <span className="font-mono text-xs text-slate-700">
                    {leg.resolved.code} — {leg.resolved.name}
                  </span>
                ) : (
                  <span className="text-xs text-red-600">
                    ⚠ belum diset admin —{" "}
                    <Link href="/settings/charges" className="font-medium underline">
                      atur di Settings
                    </Link>
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
