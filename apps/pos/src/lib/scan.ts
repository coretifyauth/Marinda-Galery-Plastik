/** Logika murni (tanpa React/Supabase) buat scan kode & operasi keranjang POS -- dipisah dari
 * page.tsx biar bisa dites langsung (scan.test.ts). Ref: docs/domain/inventory.md submodule
 * "Kode Scan Barang" -- 2 level kode (barang & satuan), satuan jual default, stok dicek GABUNGAN
 * per barang di satuan dasar. Validasi oversell otoritatif tetap di create_pos_sale; ini cuma
 * biar kasir langsung tau di layar, gak nunggu klik bayar. */

import type { CartLine, ItemRow } from "./pos-types";

const EPS = 1e-9;

export type SaleUnit = { unit_label: string; conversion_factor: number; price: number };

export type ScanResult =
  | { kind: "found"; item: { id: string; name: string }; unit: SaleUnit }
  | { kind: "not_found" }
  | { kind: "no_price"; itemName: string; unitLabel: string };

/** item_id -> stok satuan dasar (inventory_balances.qty_on_hand) + label satuan dasar buat pesan. */
export type StockMap = Map<string, { onHand: number; uom: string }>;

export type CartResult = { cart: CartLine[]; error: string | null };

type RawUnit = ItemRow["item_units"] extends (infer U)[] | null ? U : never;

function toSaleUnit(u: RawUnit): SaleUnit | null {
  if (u.price == null || u.price <= 0) return null;
  return { unit_label: u.unit_label, conversion_factor: u.conversion_factor, price: u.price };
}

/**
 * Cocokkan teks hasil scan/ketik ke barang+satuan. Urutan: kode satuan dulu (satuan persis yang
 * discan), baru kode barang (satuan jual default, fallback satuan dasar). Kode satuan/barang
 * dijamin unik lintas keduanya oleh DB (trigger check_scan_code_unique_across_tables).
 */
export function resolveScan(code: string, rows: ItemRow[]): ScanResult {
  const c = code.trim();
  if (!c) return { kind: "not_found" };

  for (const row of rows) {
    for (const u of row.item_units ?? []) {
      if (u.barcode !== c) continue;
      const unit = toSaleUnit(u);
      return unit
        ? { kind: "found", item: { id: row.id, name: row.name }, unit }
        : { kind: "no_price", itemName: row.name, unitLabel: u.unit_label };
    }
  }

  for (const row of rows) {
    if (row.barcode !== c) continue;
    const units = row.item_units ?? [];
    // Default yang (karena data basi/cache lama) gak berharga dilewati -> jatuh ke satuan dasar,
    // sama kayak barang yang belum punya default sama sekali.
    const target =
      units.find((u) => u.is_default_sale && toSaleUnit(u)) ?? units.find((u) => u.is_base);
    if (!target) return { kind: "no_price", itemName: row.name, unitLabel: row.uom };
    const unit = toSaleUnit(target);
    return unit
      ? { kind: "found", item: { id: row.id, name: row.name }, unit }
      : { kind: "no_price", itemName: row.name, unitLabel: target.unit_label };
  }

  return { kind: "not_found" };
}

export function buildStockMap(rows: ItemRow[]): StockMap {
  return new Map(rows.map((r) => [r.id, { onHand: r.inventory_balances?.qty_on_hand ?? 0, uom: r.uom }]));
}

/** Total qty satuan dasar yang dipakai semua baris keranjang buat 1 barang (lintas satuan). */
export function baseQtyInCart(cart: CartLine[], itemId: string): number {
  return cart
    .filter((l) => l.item_id === itemId)
    .reduce((sum, l) => sum + l.qty_sold * l.conversion_factor, 0);
}

/** Isi `available` tiap baris = qty maksimal baris itu (di satuannya sendiri) mengingat baris lain barang yang sama. */
export function normalizeCart(cart: CartLine[], stock: StockMap): CartLine[] {
  return cart.map((line) => {
    const info = stock.get(line.item_id);
    if (!info) return line;
    const othersBase = baseQtyInCart(cart, line.item_id) - line.qty_sold * line.conversion_factor;
    const available = Math.max(0, Math.floor((info.onHand - othersBase + EPS) / line.conversion_factor));
    return line.available === available ? line : { ...line, available };
  });
}

const fmt = (n: number) => Number(n.toFixed(3)).toLocaleString("id-ID");

function stockError(name: string, onHand: number, uom: string, neededBase: number): string {
  return `Stok ${name} tidak cukup — tersedia ${fmt(onHand)} ${uom}, kebutuhan di keranjang ${fmt(neededBase)} ${uom}.`;
}

/** Tambah 1 (qty satuan itu) ke baris (barang, satuan); baris baru kalau belum ada. */
export function addUnitToCart(
  cart: CartLine[],
  item: { id: string; name: string },
  unit: SaleUnit,
  stock: StockMap
): CartResult {
  const info = stock.get(item.id) ?? { onHand: 0, uom: "" };
  const existing = cart.find((l) => l.item_id === item.id && l.unit_label === unit.unit_label);
  const next: CartLine[] = existing
    ? cart.map((l) => (l === existing ? { ...l, qty_sold: l.qty_sold + 1 } : l))
    : [
        ...cart,
        {
          item_id: item.id,
          name: item.name,
          unit_label: unit.unit_label,
          conversion_factor: unit.conversion_factor,
          unit_price: unit.price,
          qty_sold: 1,
          available: 0,
        },
      ];
  const needed = baseQtyInCart(next, item.id);
  if (needed > info.onHand + EPS) {
    return { cart, error: stockError(item.name, info.onHand, info.uom, needed) };
  }
  return { cart: normalizeCart(next, stock), error: null };
}

/**
 * Ganti satuan 1 baris (qty angkanya tetap, harga ikut satuan baru). Kalau barang yang sama
 * sudah punya baris di satuan tujuan, kedua baris digabung (qty dijumlahkan).
 */
export function changeLineUnit(
  cart: CartLine[],
  itemId: string,
  fromLabel: string,
  to: SaleUnit,
  stock: StockMap
): CartResult {
  const line = cart.find((l) => l.item_id === itemId && l.unit_label === fromLabel);
  if (!line || to.unit_label === fromLabel) return { cart, error: null };

  const sibling = cart.find((l) => l !== line && l.item_id === itemId && l.unit_label === to.unit_label);
  const next: CartLine[] = sibling
    ? cart
        .filter((l) => l !== line)
        .map((l) => (l === sibling ? { ...l, qty_sold: l.qty_sold + line.qty_sold } : l))
    : cart.map((l) =>
        l === line
          ? { ...l, unit_label: to.unit_label, conversion_factor: to.conversion_factor, unit_price: to.price }
          : l
      );

  const info = stock.get(itemId) ?? { onHand: 0, uom: "" };
  const needed = baseQtyInCart(next, itemId);
  if (needed > info.onHand + EPS) {
    return { cart, error: stockError(line.name, info.onHand, info.uom, needed) };
  }
  return { cart: normalizeCart(next, stock), error: null };
}

/** Set qty 1 baris. qty <= 0 menghapus baris; qty di atas stok yang tersisa di-clamp (dengan pesan). */
export function setLineQty(
  cart: CartLine[],
  itemId: string,
  unitLabel: string,
  qty: number,
  stock: StockMap
): CartResult {
  const line = cart.find((l) => l.item_id === itemId && l.unit_label === unitLabel);
  if (!line) return { cart, error: null };
  if (qty <= 0) return { cart: normalizeCart(cart.filter((l) => l !== line), stock), error: null };
  // Mengurangi qty selalu boleh -- walau stok sudah turun di bawah isi keranjang (mis. katalog
  // ke-refresh), kasir harus tetap bisa membetulkan, bukan terkunci.
  if (qty <= line.qty_sold) {
    return {
      cart: normalizeCart(
        cart.map((l) => (l === line ? { ...l, qty_sold: qty } : l)),
        stock
      ),
      error: null,
    };
  }

  const info = stock.get(itemId) ?? { onHand: 0, uom: "" };
  const othersBase = baseQtyInCart(cart, itemId) - line.qty_sold * line.conversion_factor;
  const max = Math.floor((info.onHand - othersBase + EPS) / line.conversion_factor);
  if (max < 1) {
    return { cart, error: stockError(line.name, info.onHand, info.uom, othersBase + line.conversion_factor) };
  }
  const clamped = Math.min(qty, max);
  const error =
    clamped < qty ? stockError(line.name, info.onHand, info.uom, othersBase + qty * line.conversion_factor) : null;
  return {
    cart: normalizeCart(
      cart.map((l) => (l === line ? { ...l, qty_sold: clamped } : l)),
      stock
    ),
    error,
  };
}

export function removeLine(cart: CartLine[], itemId: string, unitLabel: string, stock: StockMap): CartLine[] {
  return normalizeCart(
    cart.filter((l) => !(l.item_id === itemId && l.unit_label === unitLabel)),
    stock
  );
}
