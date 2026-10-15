/** Hitungan kembalian & selisih pembulatan kasir -- PRATINJAU dari aturan create_pos_sale
 * (supabase/migrations/0054_payment_rounding.sql); angka otoritatif tetap dihitung ulang server.
 * Konsep: docs/domain/pos.md submodule "Kembalian & Selisih Pembulatan Kasir".
 * Semua hitungan dalam sen (integer) biar gak kena error float (total PPN bisa ada sen-nya). */

export type RoundingUnits = { TUNAI: number; BANK: number };
export const DEFAULT_ROUNDING_UNITS: RoundingUnits = { TUNAI: 100, BANK: 1 };

const toCents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;

/** Kembalian default = kembalian seharusnya dibulatkan KE ATAS ke kelipatan satuan tunai
 * (menguntungkan pelanggan, toko nanggung < 1 satuan). 0 kalau uang gak lebih dari total. */
export function defaultChangeGiven(total: number, tendered: number, unit: number): number {
  const due = toCents(tendered) - toCents(total);
  if (due <= 0) return 0;
  const u = toCents(unit);
  return fromCents(Math.min(Math.ceil(due / u) * u, toCents(tendered)));
}

export type CashSettlement =
  | { ok: true; cash: number; gain: number } // gain: + pendapatan (kembalian gak diambil), - beban (toko nombok)
  | { ok: false; error: string };

const rp = (n: number) => `Rp${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;

export function settleCash(total: number, tendered: number, changeGiven: number, unit: number): CashSettlement {
  if (!Number.isFinite(tendered) || tendered < 0) return { ok: false, error: "Uang diterima gak valid" };
  if (!Number.isFinite(changeGiven) || changeGiven < 0) return { ok: false, error: "Kembalian gak boleh negatif" };
  if (toCents(changeGiven) > toCents(tendered)) return { ok: false, error: "Kembalian gak boleh melebihi uang diterima" };
  const cash = toCents(tendered) - toCents(changeGiven);
  const gain = cash - toCents(total);
  if (gain < 0 && -gain >= toCents(unit)) {
    return {
      ok: false,
      error: `Kurang ${rp(fromCents(-gain))} — melebihi batas pembulatan ${rp(unit)}. Tambah uang atau isi Diskon Manual.`,
    };
  }
  return { ok: true, cash: fromCents(cash), gain: fromCents(gain) };
}

/** Bank/QRIS: nominal ditagih = total dibulatkan KE BAWAH ke satuan bank (menguntungkan pelanggan). */
export function bankCharge(total: number, unit: number): { cash: number; gain: number } {
  const u = toCents(unit);
  const cash = Math.floor(toCents(total) / u) * u;
  return { cash: fromCents(cash), gain: fromCents(cash - toCents(total)) };
}
