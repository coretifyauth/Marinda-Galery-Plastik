import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { GoodsReceiptForBill } from "@/lib/ap-credit-notes/schema";
import type { GoodsReceiptLine, GoodsReceiptNote, GoodsReceiptStatus } from "./types";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type GoodsReceiptStatusFilter = "" | GoodsReceiptStatus; // "" = semua status

export type GoodsReceiptFilters = {
  dateFrom: string;
  dateTo: string;
  purchaseOrderId: string;
  status: GoodsReceiptStatusFilter;
  page: number;
  pageSize: number;
};

type NoteRow = Omit<GoodsReceiptNote, "goods_note_lines">;

type LineRow = {
  id: string;
  goods_note_id: string;
  item_id: string;
  qty: number;
  unit_cost: number | null;
  discount_amount: number | null;
};

type ItemRow = GoodsReceiptLine["items"] & { id: string };

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Baris barang & nama item diambil 2 query terpisah lalu digabung di sini (daftar paginated, jadi jumlah id kecil).
// Nilai baris dihitung seperti server: round(qty x unit_cost, 2) - discount_amount.
export async function fetchLinesForNotes(noteIds: string[]): Promise<Map<string, GoodsReceiptLine[]>> {
  const result = new Map<string, GoodsReceiptLine[]>();
  if (noteIds.length === 0) return result;

  const { data: lineData, error: lineErr } = await supabase
    .from("goods_note_lines")
    .select("id, goods_note_id, item_id, qty, unit_cost, discount_amount")
    .in("goods_note_id", noteIds);
  if (lineErr) throw new Error(lineErr.message);
  const lines = (lineData ?? []) as unknown as LineRow[];

  const itemIds = [...new Set(lines.map((l) => l.item_id))];
  const items = new Map<string, ItemRow>();
  if (itemIds.length > 0) {
    const { data: itemData, error: itemErr } = await supabase
      .from("items")
      .select("id, name, uom, item_units(unit_label, conversion_factor)")
      .in("id", itemIds);
    if (itemErr) throw new Error(itemErr.message);
    for (const it of (itemData ?? []) as unknown as ItemRow[]) items.set(it.id, it);
  }

  for (const l of lines) {
    const item = items.get(l.item_id);
    const unitCost = l.unit_cost ?? 0;
    const discount = l.discount_amount ?? 0;
    const line: GoodsReceiptLine = {
      id: l.id,
      goods_note_id: l.goods_note_id,
      item_id: l.item_id,
      qty: l.qty,
      unit_cost: unitCost,
      discount_amount: discount,
      line_value: round2(round2(l.qty * unitCost) - discount),
      items: item
        ? { name: item.name, uom: item.uom, item_units: item.item_units ?? [] }
        : { name: "(item tidak ditemukan)", uom: "", item_units: [] },
    };
    const list = result.get(l.goods_note_id) ?? [];
    list.push(line);
    result.set(l.goods_note_id, list);
  }
  return result;
}

async function withLines(notes: NoteRow[]): Promise<GoodsReceiptNote[]> {
  const lines = await fetchLinesForNotes(notes.map((n) => n.id));
  return notes.map((n) => ({ ...n, goods_note_lines: lines.get(n.id) ?? [] }));
}

export async function fetchGoodsReceipts(
  filters: GoodsReceiptFilters
): Promise<{ rows: GoodsReceiptNote[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("goods_receipts_overview")
    .select("*", { count: "exact" })
    .order("note_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("note_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("note_date", filters.dateTo);
  if (filters.purchaseOrderId) query = query.eq("order_id", filters.purchaseOrderId);
  if (filters.status) query = query.eq("status", filters.status);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { rows: await withLines((data ?? []) as unknown as NoteRow[]), total: count ?? 0 };
}

// Semua barang masuk 1 tagihan (terbaru dulu) -- dipakai detail tagihan (kolam) untuk menampilkan kirimannya.
export async function fetchGoodsReceiptsForBill(billId: string): Promise<GoodsReceiptNote[]> {
  const { data, error } = await supabase
    .from("goods_receipts_overview")
    .select("*")
    .eq("bill_id", billId)
    .order("note_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return withLines((data ?? []) as unknown as NoteRow[]);
}

// Seluruh barang masuk AKTIF 1 tagihan, digabung PER ITEM: qty dijumlah, harga = nilai bersih / qty. Dipakai layar
// retur/tukar barang/detail tagihan (batas qty retur = total qty diterima semua barang masuk tagihan itu).
// Null kalau tagihan tanpa barang masuk aktif.
export async function fetchGoodsReceiptForBill(billId: string): Promise<GoodsReceiptForBill | null> {
  const { data, error } = await supabase
    .from("goods_receipts_overview")
    .select("id")
    .eq("bill_id", billId)
    .eq("status", "aktif");
  if (error) throw new Error(error.message);
  const noteIds = ((data ?? []) as { id: string }[]).map((n) => n.id);
  if (noteIds.length === 0) return null;

  const lineMap = await fetchLinesForNotes(noteIds);
  const perItem = new Map<string, { qty: number; value: number; items: { name: string; uom: string } }>();
  for (const lines of lineMap.values()) {
    for (const l of lines) {
      const acc = perItem.get(l.item_id) ?? { qty: 0, value: 0, items: { name: l.items.name, uom: l.items.uom } };
      acc.qty += l.qty;
      acc.value += l.line_value;
      perItem.set(l.item_id, acc);
    }
  }
  return {
    id: noteIds[0],
    goods_note_lines: [...perItem.entries()].map(([item_id, a]) => ({
      item_id,
      qty: a.qty,
      unit_cost: a.qty > 0 ? a.value / a.qty : 0,
      items: a.items,
    })),
  };
}

export function useGoodsReceipts(filters: GoodsReceiptFilters) {
  return useQuery({
    queryKey: ["goods_receipt_notes", filters],
    queryFn: () => fetchGoodsReceipts(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function useGoodsReceiptsForBill(billId: string) {
  return useQuery({
    queryKey: ["goods_receipt_notes", "bill", billId],
    queryFn: () => fetchGoodsReceiptsForBill(billId),
    enabled: !!billId,
    staleTime: 5_000,
  });
}
