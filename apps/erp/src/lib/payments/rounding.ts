import { supabase } from "@/lib/supabase/client";

// Pratinjau aturan pelunasan record_payment (supabase/migrations/0054_payment_rounding.sql) --
// angka otoritatif tetap dihitung server, ini cuma buat nampilin ke user sebelum submit.
// Konsep: docs/domain/accounts-payable.md submodule "Selisih Pembulatan Pelunasan".

export type PaymentMethod = "TUNAI" | "BANK";
export type RoundingUnits = Record<PaymentMethod, number>;

export const DEFAULT_ROUNDING_UNITS: RoundingUnits = { TUNAI: 100, BANK: 1 };

export async function fetchRoundingUnits(): Promise<RoundingUnits> {
  const { data } = await supabase.from("app_settings").select("rounding_unit_cash, rounding_unit_bank").maybeSingle();
  if (!data) return DEFAULT_ROUNDING_UNITS;
  return { TUNAI: Number(data.rounding_unit_cash), BANK: Number(data.rounding_unit_bank) };
}

export type PaymentPreview =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  /** Nominal = sisa tagihan persis. */
  | { kind: "exact"; applied: number }
  /** Nominal = sisa dibulatkan ke bawah/atas -> lunas. gain: + pendapatan, - beban (sudut pandang perusahaan). */
  | { kind: "rounded"; applied: number; gain: number }
  | { kind: "partial"; applied: number; remainingAfter: number }
  | { kind: "overpay"; floor: number; ceil: number };

// Hitung dalam sen (integer) biar gak kena error float (387239.4 * 100 dst).
const toCents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;

export function roundingBounds(remaining: number, unit: number): { floor: number; ceil: number } {
  const r = toCents(remaining);
  const u = toCents(unit);
  return { floor: fromCents(Math.floor(r / u) * u), ceil: fromCents(Math.ceil(r / u) * u) };
}

/** type: OUTBOUND = pelunasan piutang (AR, kita terima uang), INBOUND = pelunasan utang (AP, kita bayar). */
export function previewPayment(
  type: "OUTBOUND" | "INBOUND",
  remaining: number,
  amountInput: string,
  unit: number
): PaymentPreview {
  if (amountInput.trim() === "") return { kind: "empty" };
  const amount = Number(amountInput);
  if (!Number.isFinite(amount) || amount < 0) return { kind: "invalid", message: "Jumlah gak boleh negatif" };
  if (remaining <= 0) return { kind: "invalid", message: "Transaksi ini sudah gak punya sisa tagihan" };

  const cash = toCents(amount);
  const rem = toCents(remaining);
  const { floor, ceil } = roundingBounds(remaining, unit);

  if (cash === rem) return { kind: "exact", applied: remaining };
  if (cash === toCents(floor) || cash === toCents(ceil)) {
    const gain = type === "OUTBOUND" ? cash - rem : rem - cash;
    return { kind: "rounded", applied: remaining, gain: fromCents(gain) };
  }
  if (cash > rem) return { kind: "overpay", floor, ceil };
  if (cash === 0) return { kind: "invalid", message: "Jumlah dibayar harus lebih dari 0" };
  return { kind: "partial", applied: amount, remainingAfter: fromCents(rem - cash) };
}
