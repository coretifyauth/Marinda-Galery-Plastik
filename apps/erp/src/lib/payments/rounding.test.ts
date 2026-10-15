import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ supabase: {} }));

import { previewPayment, roundingBounds } from "./rounding";

// Skenario persis docs/domain/accounts-payable.md & accounts-receivable.md submodule
// "Selisih Pembulatan Pelunasan".
describe("previewPayment -- AP (INBOUND)", () => {
  const remaining = 387239.4;

  it("transfer dibulatkan ke bawah -> lunas, pendapatan 0,40", () => {
    expect(previewPayment("INBOUND", remaining, "387239", 1)).toEqual({ kind: "rounded", applied: remaining, gain: 0.4 });
  });

  it("transfer dibulatkan ke atas -> lunas, beban 0,60", () => {
    expect(previewPayment("INBOUND", remaining, "387240", 1)).toEqual({ kind: "rounded", applied: remaining, gain: -0.6 });
  });

  it("transfer kurang Rp39 bukan pembulatan -> cicilan", () => {
    expect(previewPayment("INBOUND", remaining, "387200", 1)).toEqual({
      kind: "partial",
      applied: 387200,
      remainingAfter: 39.4,
    });
  });

  it("tunai dibulatkan ke ratusan -> lunas, pendapatan 39,40", () => {
    expect(previewPayment("INBOUND", remaining, "387200", 100)).toEqual({ kind: "rounded", applied: remaining, gain: 39.4 });
  });

  it("lebih dari pembulatan ke atas -> overpay", () => {
    expect(previewPayment("INBOUND", remaining, "387300", 1)).toEqual({ kind: "overpay", floor: 387239, ceil: 387240 });
  });

  it("sisa receh di bawah satuan boleh ditutup Rp0", () => {
    expect(previewPayment("INBOUND", 0.4, "0", 1)).toEqual({ kind: "rounded", applied: 0.4, gain: 0.4 });
  });

  it("Rp0 untuk sisa >= satuan ditolak", () => {
    expect(previewPayment("INBOUND", remaining, "0", 1).kind).toBe("invalid");
  });

  it("nominal persis sisa -> biasa", () => {
    expect(previewPayment("INBOUND", remaining, "387239.4", 1)).toEqual({ kind: "exact", applied: remaining });
  });
});

describe("previewPayment -- AR (OUTBOUND), arah kebalik", () => {
  const remaining = 254861.7;

  it("pelanggan bayar kurang (tunai) -> beban 61,70", () => {
    expect(previewPayment("OUTBOUND", remaining, "254800", 100)).toEqual({ kind: "rounded", applied: remaining, gain: -61.7 });
  });

  it("pelanggan bayar lebih (tunai) -> pendapatan 38,30", () => {
    expect(previewPayment("OUTBOUND", remaining, "254900", 100)).toEqual({ kind: "rounded", applied: remaining, gain: 38.3 });
  });

  it("tunai lebih dari pembulatan ke atas ditolak", () => {
    expect(previewPayment("OUTBOUND", remaining, "255000", 100).kind).toBe("overpay");
  });
});

describe("roundingBounds", () => {
  it("sisa sudah kelipatan satuan -> bawah = atas = sisa", () => {
    expect(roundingBounds(254800, 100)).toEqual({ floor: 254800, ceil: 254800 });
  });
});
