import { describe, expect, it } from "vitest";
import { bankCharge, defaultChangeGiven, settleCash } from "./cash-rounding";

// Skenario persis docs/domain/pos.md submodule "Kembalian & Selisih Pembulatan Kasir".
describe("kasir tunai (satuan Rp100)", () => {
  it("uang pas -> tanpa selisih", () => {
    expect(defaultChangeGiven(12350, 12350, 100)).toBe(0);
    expect(settleCash(12350, 12350, 0, 100)).toEqual({ ok: true, cash: 12350, gain: 0 });
  });

  it("kembalian 7.650 default dibulatkan ke atas jadi 7.700 -> beban 50", () => {
    expect(defaultChangeGiven(12350, 20000, 100)).toBe(7700);
    expect(settleCash(12350, 20000, 7700, 100)).toEqual({ ok: true, cash: 12300, gain: -50 });
  });

  it("pelanggan merelakan kembalian 650 -> pendapatan 650", () => {
    expect(settleCash(12350, 20000, 7000, 100)).toEqual({ ok: true, cash: 13000, gain: 650 });
  });

  it("kembalian gak diambil sama sekali -> pendapatan berapa pun", () => {
    expect(settleCash(12350, 20000, 0, 100)).toEqual({ ok: true, cash: 20000, gain: 7650 });
  });

  it("uang kurang 50 -> toko nanggung", () => {
    expect(settleCash(12350, 12300, 0, 100)).toEqual({ ok: true, cash: 12300, gain: -50 });
  });

  it("uang kurang 350 -> ditolak", () => {
    expect(settleCash(12350, 12000, 0, 100).ok).toBe(false);
  });

  it("kembalian kebesaran (nombok 150) -> ditolak", () => {
    expect(settleCash(12350, 20000, 7800, 100).ok).toBe(false);
  });

  it("kembalian melebihi uang diterima -> ditolak", () => {
    expect(settleCash(12350, 20000, 20001, 100).ok).toBe(false);
  });

  it("total ada sen (PPN) -> kembalian 1.297,05 jadi 1.300, beban 2,95", () => {
    expect(defaultChangeGiven(13702.95, 15000, 100)).toBe(1300);
    expect(settleCash(13702.95, 15000, 1300, 100)).toEqual({ ok: true, cash: 13700, gain: -2.95 });
  });
});

describe("kasir bank/QRIS (satuan Rp1)", () => {
  it("total 13.702,95 ditagih 13.702, beban 0,95", () => {
    expect(bankCharge(13702.95, 1)).toEqual({ cash: 13702, gain: -0.95 });
  });

  it("total bulat -> tanpa selisih", () => {
    expect(bankCharge(12350, 1)).toEqual({ cash: 12350, gain: 0 });
  });
});
