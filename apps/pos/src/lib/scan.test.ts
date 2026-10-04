import { describe, expect, it } from "vitest";
import {
  addUnitToCart,
  baseQtyInCart,
  buildStockMap,
  changeLineUnit,
  normalizeCart,
  removeLine,
  resolveScan,
  setLineQty,
  type SaleUnit,
} from "./scan";
import type { CartLine, ItemRow } from "./pos-types";

// Barang A: pcs(1)=800, ikat(5)=3.800, bal(125)=95.000, dos(1250)=900.000 (diskon grosir, gak proporsional)
const PCS: SaleUnit = { unit_label: "pcs", conversion_factor: 1, price: 800 };
const IKAT: SaleUnit = { unit_label: "ikat", conversion_factor: 5, price: 3800 };
const BAL: SaleUnit = { unit_label: "bal", conversion_factor: 125, price: 95000 };
const DOS: SaleUnit = { unit_label: "dos", conversion_factor: 1250, price: 900000 };

function itemA(overrides: Partial<ItemRow> = {}, onHand = 1500): ItemRow {
  return {
    id: "item-a",
    name: "Kantong Plastik A",
    uom: "pcs",
    category_id: null,
    barcode: "SKU-2026-00001",
    item_units: [
      { unit_label: "pcs", conversion_factor: 1, price: 800, is_base: true, barcode: null, is_default_sale: false },
      { unit_label: "ikat", conversion_factor: 5, price: 3800, is_base: false, barcode: null, is_default_sale: true },
      { unit_label: "bal", conversion_factor: 125, price: 95000, is_base: false, barcode: null, is_default_sale: false },
      { unit_label: "dos", conversion_factor: 1250, price: 900000, is_base: false, barcode: "8991234567890", is_default_sale: false },
    ],
    inventory_balances: { qty_on_hand: onHand },
    ...overrides,
  };
}

describe("resolveScan", () => {
  it("kode barang -> satuan jual default", () => {
    const r = resolveScan("SKU-2026-00001", [itemA()]);
    expect(r).toMatchObject({ kind: "found", item: { id: "item-a" }, unit: { unit_label: "ikat", conversion_factor: 5 } });
  });

  it("kode barang tanpa default -> fallback satuan dasar", () => {
    const row = itemA();
    row.item_units = row.item_units!.map((u) => ({ ...u, is_default_sale: false }));
    const r = resolveScan("SKU-2026-00001", [row]);
    expect(r).toMatchObject({ kind: "found", unit: { unit_label: "pcs" } });
  });

  it("cache lama tanpa field is_default_sale/barcode barang -> tetap jalan (fallback dasar / not_found)", () => {
    const row = itemA();
    row.item_units = row.item_units!.map((u) => ({ unit_label: u.unit_label, conversion_factor: u.conversion_factor, price: u.price, is_base: u.is_base, barcode: u.barcode }));
    expect(resolveScan("SKU-2026-00001", [row])).toMatchObject({ kind: "found", unit: { unit_label: "pcs" } });
    const noItemCode = { ...row };
    delete noItemCode.barcode;
    expect(resolveScan("SKU-2026-00001", [noItemCode])).toEqual({ kind: "not_found" });
  });

  it("kode satuan menang atas default -> satuan persis yang discan", () => {
    const r = resolveScan("8991234567890", [itemA()]);
    expect(r).toMatchObject({ kind: "found", unit: { unit_label: "dos", conversion_factor: 1250 } });
  });

  it("kode gak dikenal / kosong -> not_found", () => {
    expect(resolveScan("XXX", [itemA()])).toEqual({ kind: "not_found" });
    expect(resolveScan("   ", [itemA()])).toEqual({ kind: "not_found" });
  });

  it("satuan hasil scan belum berharga -> no_price (bukan 'gak ketemu')", () => {
    const row = itemA();
    row.item_units![0].price = null; // pcs (dasar) tanpa harga
    row.item_units = row.item_units!.map((u) => ({ ...u, is_default_sale: false })); // gak ada default -> dasar
    expect(resolveScan("SKU-2026-00001", [row])).toEqual({ kind: "no_price", itemName: "Kantong Plastik A", unitLabel: "pcs" });
  });

  it("default basi yang gak berharga dilewati -> jatuh ke satuan dasar", () => {
    const row = itemA();
    row.item_units![1].price = null; // ikat (default) kehilangan harga di data lama
    expect(resolveScan("SKU-2026-00001", [row])).toMatchObject({ kind: "found", unit: { unit_label: "pcs" } });
  });
});

describe("keranjang & stok gabungan (satuan dasar)", () => {
  const item = { id: "item-a", name: "Kantong Plastik A" };

  function stock(onHand: number) {
    return buildStockMap([itemA({}, onHand)]);
  }

  it("100 pcs + 1 bal (125 pcs) ditolak kalau stok total 150 pcs", () => {
    const s = stock(150);
    let cart: CartLine[] = [];
    const first = addUnitToCart(cart, item, PCS, s);
    cart = first.cart;
    cart = setLineQty(cart, item.id, "pcs", 100, s).cart;
    expect(baseQtyInCart(cart, item.id)).toBe(100);

    const r = addUnitToCart(cart, item, BAL, s);
    expect(r.error).toContain("Stok Kantong Plastik A tidak cukup");
    expect(r.cart).toBe(cart); // keranjang gak berubah
  });

  it("3 dos (3.750 pcs) ditolak kalau stok 3.000 pcs; 2 dos lolos, dos ke-3 ditolak", () => {
    const s = stock(3000);
    let cart = addUnitToCart([], item, DOS, s).cart;
    expect(addUnitToCart(cart, item, DOS, s).error).toBeNull(); // 2 dos = 2.500
    cart = addUnitToCart(cart, item, DOS, s).cart;
    expect(cart[0].qty_sold).toBe(2);
    const third = addUnitToCart(cart, item, DOS, s);
    expect(third.error).not.toBeNull();
    expect(third.cart[0].qty_sold).toBe(2);
  });

  it("2 dos + 400 pcs lolos (2.900 <= 3.000), 101 pcs lagi ditolak", () => {
    const s = stock(3000);
    let cart = addUnitToCart([], item, DOS, s).cart;
    cart = addUnitToCart(cart, item, DOS, s).cart;
    cart = addUnitToCart(cart, item, PCS, s).cart;
    cart = setLineQty(cart, item.id, "pcs", 400, s).cart;
    expect(baseQtyInCart(cart, item.id)).toBe(2900);
    const over = setLineQty(cart, item.id, "pcs", 501, s);
    expect(over.cart.find((l) => l.unit_label === "pcs")!.qty_sold).toBe(500); // clamp ke sisa stok
    expect(over.error).not.toBeNull();
  });

  it("normalizeCart: available per baris memperhitungkan baris lain barang yang sama", () => {
    const s = stock(1500);
    let cart = addUnitToCart([], item, IKAT, s).cart; // 1 ikat = 5 pcs
    cart = addUnitToCart(cart, item, PCS, s).cart; // 1 pcs
    cart = setLineQty(cart, item.id, "ikat", 2, s).cart; // 10 pcs
    cart = setLineQty(cart, item.id, "pcs", 5, s).cart; // 5 pcs
    const ikat = cart.find((l) => l.unit_label === "ikat")!;
    const pcs = cart.find((l) => l.unit_label === "pcs")!;
    expect(pcs.available).toBe(1490); // 1500 - 10 (ikat)
    expect(ikat.available).toBe(299); // floor((1500 - 5) / 5)
  });

  it("barang lain gak saling ngurangin stok", () => {
    const b = { ...itemA({}, 10), id: "item-b", name: "B" };
    const s = buildStockMap([itemA({}, 150), b]);
    let cart = addUnitToCart([], item, BAL, s).cart; // 125 dari 150
    const r = addUnitToCart(cart, { id: "item-b", name: "B" }, PCS, s);
    expect(r.error).toBeNull();
    cart = r.cart;
    expect(cart).toHaveLength(2);
  });

  it("changeLineUnit: harga ikut satuan baru, qty angka tetap", () => {
    const s = stock(1500);
    let cart = addUnitToCart([], item, IKAT, s).cart; // 1 ikat @3.800
    const r = changeLineUnit(cart, item.id, "ikat", BAL, s);
    expect(r.error).toBeNull();
    cart = r.cart;
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({ unit_label: "bal", conversion_factor: 125, unit_price: 95000, qty_sold: 1 });
  });

  it("changeLineUnit: bertabrakan dengan baris satuan tujuan -> digabung (qty dijumlahkan)", () => {
    const s = stock(1500);
    let cart = addUnitToCart([], item, PCS, s).cart;
    cart = setLineQty(cart, item.id, "pcs", 2, s).cart;
    cart = addUnitToCart(cart, item, IKAT, s).cart; // 1 ikat
    const r = changeLineUnit(cart, item.id, "ikat", PCS, s); // ikat -> pcs: 2 pcs + 1 (angka tetap) = 3 pcs
    expect(r.cart).toHaveLength(1);
    expect(r.cart[0]).toMatchObject({ unit_label: "pcs", qty_sold: 3 });
  });

  it("changeLineUnit ke satuan yang melebihi stok ditolak, keranjang utuh", () => {
    const s = stock(100);
    const cart = addUnitToCart([], item, PCS, s).cart;
    const r = changeLineUnit(cart, item.id, "pcs", BAL, s); // 1 bal = 125 > 100
    expect(r.error).not.toBeNull();
    expect(r.cart).toBe(cart);
  });

  it("mengurangi qty tetap boleh walau stok sudah turun di bawah isi keranjang", () => {
    const s = stock(1500);
    let cart = addUnitToCart([], item, BAL, s).cart;
    cart = setLineQty(cart, item.id, "bal", 10, s).cart; // 1.250 pcs
    const lowStock = stock(100); // katalog ke-refresh, stok anjlok
    const r = setLineQty(cart, item.id, "bal", 5, lowStock);
    expect(r.error).toBeNull();
    expect(r.cart[0].qty_sold).toBe(5);
  });

  it("qty 0 / removeLine menghapus baris dan menghitung ulang available baris lain", () => {
    const s = stock(1500);
    let cart = addUnitToCart([], item, BAL, s).cart;
    cart = addUnitToCart(cart, item, PCS, s).cart;
    expect(cart.find((l) => l.unit_label === "pcs")!.available).toBe(1375);
    cart = removeLine(cart, item.id, "bal", s);
    expect(cart).toHaveLength(1);
    expect(cart[0].available).toBe(1500);
    expect(setLineQty(cart, item.id, "pcs", 0, s).cart).toHaveLength(0);
  });

  it("normalizeCart gak menyentuh baris kalau stok barangnya gak diketahui", () => {
    const line: CartLine = { item_id: "x", name: "X", unit_label: "pcs", conversion_factor: 1, unit_price: 1, qty_sold: 1, available: 7 };
    expect(normalizeCart([line], new Map())).toEqual([line]);
  });
});
