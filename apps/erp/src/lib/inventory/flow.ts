import { supabase } from "@/lib/supabase/client";

/** Satu baris mentah dari RPC `report_item_flow` (0067). Kolom lain di RPC (saldo awal, stok sekarang) tidak dipakai. */
export type ItemFlowRaw = {
  item_id: string;
  item_name: string;
  uom: string;
  breakdown: { label: string; in: number; out: number }[];
};

export type FlowDirection = "masuk" | "keluar";

// source_label dari view inventory_movements_with_source (0061). Dashboard hanya melacak barang TERJUAL dan DIBELI.
export const FLOW_LABELS = {
  penjualan: "Penjualan (Kirim Barang)",
  batalPenjualan: "Pembatalan Barang Keluar",
  pembelian: "Pembelian (Terima Barang)",
  batalPembelian: "Pembatalan Barang Masuk",
} as const;

export type ItemFlow = {
  itemId: string;
  name: string;
  uom: string;
  /** keluar: terjual (penjualan - pembatalannya); masuk: dibeli (barang diterima - pembatalannya). Satuan dasar. */
  qty: number;
};

// Qty numeric(14,3): bulatkan ke 1/1000 supaya 0.1+0.2 tidak melenceng.
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Retur dari customer, retur ke supplier, produksi, opname, dan garansi sengaja TIDAK dihitung: dashboard ini hanya
 * melacak yang terjual dan yang dibeli. Pembatalan dokumen penjualan/pembelian dikurangkan, karena dokumen batal
 * bukan penjualan/pembelian.
 */
export function computeItemFlow(raw: ItemFlowRaw, direction: FlowDirection): ItemFlow {
  const sum = (label: string, side: "in" | "out") =>
    raw.breakdown.filter((b) => b.label === label).reduce((s, b) => r3(s + Number(b[side])), 0);
  const qty =
    direction === "keluar"
      ? sum(FLOW_LABELS.penjualan, "out") - sum(FLOW_LABELS.batalPenjualan, "in")
      : sum(FLOW_LABELS.pembelian, "in") - sum(FLOW_LABELS.batalPembelian, "out");
  return { itemId: raw.item_id, name: raw.item_name, uom: raw.uom, qty: Math.max(0, r3(qty)) };
}

/** Satu satuan barang untuk tampilan. `factor` = berapa satuan dasar dalam 1 satuan ini. */
export type UnitView = { label: string; factor: number; isDefault: boolean };

export type ItemUnitRow = {
  item_id: string;
  unit_label: string;
  conversion_factor: number;
  is_default_sale: boolean;
};

/**
 * Semua satuan 1 barang, terbesar -> terkecil. Satuan default = yang ditandai `is_default_sale`; kalau tidak
 * ada, satuan dasar (aturan sama dengan scan di POS). Satuan dasar selalu ada, walau barang tak punya baris item_units.
 */
export function buildItemUnits(baseUom: string, rows: ItemUnitRow[]): UnitView[] {
  const byLabel = new Map<string, UnitView>();
  for (const r of rows) {
    byLabel.set(r.unit_label, { label: r.unit_label, factor: Number(r.conversion_factor), isDefault: r.is_default_sale });
  }
  if (![...byLabel.values()].some((u) => u.factor === 1)) byLabel.set(baseUom, { label: baseUom, factor: 1, isDefault: false });
  const units = [...byLabel.values()].sort((a, b) => b.factor - a.factor);
  if (!units.some((u) => u.isDefault)) units[units.length - 1].isDefault = true; // terkecil = satuan dasar
  return units;
}

/** Qty satuan dasar -> qty di satuan lain (3 desimal, presisi kolom qty). */
export const inUnit = (qtyBase: number, factor: number): number => Math.round((qtyBase / factor) * 1000) / 1000;

// Ambil semua item_units sekaligus (bukan .in(itemIds): ratusan uuid membuat URL kepanjangan).
export async function fetchAllItemUnits(): Promise<ItemUnitRow[]> {
  const all: ItemUnitRow[] = [];
  for (let start = 0; ; ) {
    const { data, error } = await supabase
      .from("item_units")
      .select("item_id, unit_label, conversion_factor, is_default_sale")
      .order("id")
      .range(start, start + BATCH - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ItemUnitRow[];
    if (rows.length === 0) break;
    all.push(...rows);
    start += rows.length;
  }
  return all;
}

// PostgREST membatasi baris per request -- ambil berhalaman (urutan RPC stabil: nama lalu id).
const BATCH = 1000;

export async function fetchItemFlowRaw(from: string, to: string): Promise<ItemFlowRaw[]> {
  const all: ItemFlowRaw[] = [];
  // Maju sebanyak baris yang BENAR-BENAR diterima, bukan BATCH: kalau max_rows project lebih kecil dari BATCH,
  // data tidak terpotong diam-diam. Berhenti saat halaman kosong (1 request ekstra, murah).
  for (let start = 0; ; ) {
    const { data, error } = await supabase
      .rpc("report_item_flow", { p_from: from, p_to: to })
      .range(start, start + BATCH - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ItemFlowRaw[];
    if (rows.length === 0) break;
    all.push(...rows);
    start += rows.length;
  }
  return all;
}
