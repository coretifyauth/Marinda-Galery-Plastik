import { Label } from "@/components/ui/label";
import type { ResolvedAccount } from "@/lib/default-accounts/schema";

export type CashMethod = "TUNAI" | "BANK";

/** Field "Akun Kas/Bank" BUKAN akun bebas — satu-satunya pilihan nyata di situ
 * sebenarnya cuma metode bayar (tunai fisik vs transfer/QRIS masuk rekening), sama
 * pola yang sudah dipakai `apps/pos` (ACCOUNT_CODES.KAS_TOKO/KAS_BANK). Komponen ini
 * niru itu tapi baca dari default_account_settings (role_key `cash.tunai`/`cash.bank`)
 * biar admin bisa reassign tanpa deploy kode. */
export function CashMethodField({
  label,
  method,
  onChange,
  defaultAccounts,
  htmlFor,
}: {
  label: string;
  method: CashMethod;
  onChange: (method: CashMethod) => void;
  defaultAccounts: Record<string, ResolvedAccount>;
  htmlFor: string;
}) {
  const resolved = resolveCashAccount(method, defaultAccounts);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      <div id={htmlFor} className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange("TUNAI")}
          className={`rounded-lg border px-3 py-2 text-sm font-medium ${
            method === "TUNAI"
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Tunai
        </button>
        <button
          type="button"
          onClick={() => onChange("BANK")}
          className={`rounded-lg border px-3 py-2 text-sm font-medium ${
            method === "BANK"
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Transfer Bank
        </button>
      </div>
      {resolved ? (
        <p className="text-xs text-slate-500">
          {resolved.code} — {resolved.name}
        </p>
      ) : (
        <p className="text-xs text-red-600">⚠ Akun belum diset admin — atur di Settings → Default Akun.</p>
      )}
    </div>
  );
}

export function resolveCashAccount(
  method: CashMethod,
  defaultAccounts: Record<string, ResolvedAccount>
): ResolvedAccount | undefined {
  return defaultAccounts[method === "TUNAI" ? "cash.tunai" : "cash.bank"];
}
