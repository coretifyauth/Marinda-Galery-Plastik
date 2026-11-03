import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ supabase: {} }));

import { buildItemUnits, computeItemFlow, FLOW_LABELS, inUnit, type ItemFlowRaw } from "./flow";

const raw = (breakdown: ItemFlowRaw["breakdown"]): ItemFlowRaw => ({ item_id: "a", item_name: "Tepung", uom: "kg", breakdown });

describe("computeItemFlow", () => {
  const rows = raw([
    { label: FLOW_LABELS.pembelian, in: 300, out: 0 },
    { label: FLOW_LABELS.batalPembelian, in: 0, out: 50 },
    { label: FLOW_LABELS.penjualan, in: 0, out: 120 },
    { label: FLOW_LABELS.batalPenjualan, in: 20, out: 0 },
    { label: "Produksi (Konsumsi Bahan)", in: 0, out: 200 },
    { label: "Penyesuaian Stock Opname", in: 0, out: 10 },
    { label: "Retur dari Customer", in: 5, out: 0 },
  ]);

  it("keluar = terjual: penjualan dikurangi pembatalannya; produksi/opname/retur tidak dihitung", () => {
    expect(computeItemFlow(rows, "keluar").qty).toBe(100);
  });

  it("masuk = dibeli: barang diterima dikurangi pembatalannya", () => {
    expect(computeItemFlow(rows, "masuk").qty).toBe(250);
  });

  it("tanpa penjualan/pembelian: 0, tidak negatif", () => {
    expect(computeItemFlow(raw([{ label: FLOW_LABELS.batalPenjualan, in: 5, out: 0 }]), "keluar").qty).toBe(0);
    expect(computeItemFlow(raw([{ label: "Penyesuaian Stock Opname", in: 5, out: 0 }]), "masuk").qty).toBe(0);
  });

  it("qty desimal tidak melenceng", () => {
    const f = computeItemFlow(raw([{ label: FLOW_LABELS.penjualan, in: 0, out: 0.3 }, { label: FLOW_LABELS.batalPenjualan, in: 0.1, out: 0 }]), "keluar");
    expect(f.qty).toBe(0.2);
  });
});

describe("buildItemUnits", () => {
  const row = (unit_label: string, conversion_factor: number, is_default_sale = false) => ({
    item_id: "a",
    unit_label,
    conversion_factor,
    is_default_sale,
  });

  it("semua satuan tampil terbesar dulu; default = yang ditandai", () => {
    const u = buildItemUnits("pcs", [row("pcs", 1), row("box", 144, true), row("pack", 12)]);
    expect(u.map((x) => x.label)).toEqual(["box", "pack", "pcs"]);
    expect(u.filter((x) => x.isDefault).map((x) => x.label)).toEqual(["box"]);
  });

  it("tanpa tanda default: satuan dasar", () => {
    const u = buildItemUnits("pcs", [row("pcs", 1), row("box", 144)]);
    expect(u.find((x) => x.isDefault)?.label).toBe("pcs");
  });

  it("tanpa baris item_units: satuan dasar dari items.uom", () => {
    expect(buildItemUnits("kg", [])).toEqual([{ label: "kg", factor: 1, isDefault: true }]);
  });
});

describe("inUnit", () => {
  it("konversi dari satuan dasar", () => {
    expect(inUnit(288, 144)).toBe(2);
    expect(inUnit(1, 3)).toBe(0.333);
  });
});
