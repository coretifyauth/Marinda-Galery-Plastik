import Link from "next/link";
import { Label } from "@/components/ui/label";
import type { ResolvedAccount } from "@/lib/default-accounts/schema";

/** Pengganti <Select> bebas buat akun yang SELALU resolve ke 1 akun yang sama —
 * baca dari default_account_settings (role_key), tampil read-only, bukan dipilih
 * user. Kalau role_key belum diset admin, tampil warning merah + link ke Settings,
 * BUKAN fallback ke picker bebas — fallback ke picker bebas ngalahin balik tujuan
 * komponen ini (memory/preferences/ui/form-components.md). */
export function LockedAccountField({
  label,
  resolved,
  htmlFor,
}: {
  label: string;
  resolved: ResolvedAccount | undefined;
  htmlFor: string;
}) {
  if (!resolved) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        <div
          id={htmlFor}
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          ⚠ Akun belum diset admin.{" "}
          <Link href="/settings/charges" className="font-medium underline">
            Atur di Settings → Default Akun
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      <div
        id={htmlFor}
        className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
      >
        {resolved.code} — {resolved.name}
      </div>
    </div>
  );
}
