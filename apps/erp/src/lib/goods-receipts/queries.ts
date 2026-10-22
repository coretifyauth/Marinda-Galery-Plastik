import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { GoodsReceiptForBill } from "@/lib/ap-credit-notes/schema";
import type { GoodsReceiptLine, GoodsReceiptNote, GoodsReceiptStatus } from "./types";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type GoodsReceiptStatusFilter = "aktif" | "" | GoodsReceiptStatus; // "aktif" = default, sembunyikan yang dibatalkan

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
  goods_note_line_id: string;
  goods_note_id: string;
  item_id: string;
  qty: number;
  unit_cost: number;
  discount_amount: number;
  line_value: number;
};

type ItemRow = GoodsReceiptLine["items"] & { id: string };

// View/embedding PostgREST gak bisa dipakai lintas view, jadi baris barang & nama item diambil 2 query
// terpisah lalu digabung di sini (daftar paginated, jadi jumlah id kecil).
export async function fetchLinesForNotes(noteIds: string[]): Promise<Map<string, GoodsReceiptLine[]>> {
  const result = new Map<string, GoodsReceiptLine[]>();
  if (noteIds.length === 0) return result;

  const { data: lineData, error: lineErr } = await supabase
    .from("goods_note_line_current_cost")
    .select("goods_note_line_id, goods_note_id, item_id, qty, unit_cost, discount_amount, line_value")
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
    const line: GoodsReceiptLine = {
      id: l.goods_note_line_id,
      goods_note_id: l.goods_note_id,
      item_id: l.item_id,
      qty: l.qty,
      unit_cost: l.unit_cost,
      discount_amount: l.discount_amount,
      line_value: l.line_value,
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

export async function fetchGoodsReceipts(
  filters: GoodsReceiptFilters
): Promise<{ rows: GoodsReceiptNote[]; total: number }> {
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("goods_notes_with_billing_status")
    .select("*", { count: "exact" })
    .order("note_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.dateFrom) query = query.gte("note_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("note_date", filters.dateTo);
  if (filters.purchaseOrderId) query = query.eq("order_id", filters.purchaseOrderId);

  if (filters.status === "aktif") query = query.neq("billing_status", "dibatalkan");
  else if (filters.status) query = query.eq("billing_status", filters.status);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  const notes = (data ?? []) as unknown as NoteRow[];
  const lines = await fetchLinesForNotes(notes.map((n) => n.id));
  return {
    rows: notes.map((n) => ({ ...n, goods_note_lines: lines.get(n.id) ?? [] })),
    total: count ?? 0,
  };
}

// Seluruh barang masuk yang ditagih 1 tagihan (lewat goods_note_billings -- 1 tagihan bisa menutup banyak
// barang masuk), digabung PER ITEM: qty dijumlah, harga = nilai berlaku / qty. Dipakai layar retur/tukar
// barang/detail tagihan yang dulu mengira 1 tagihan = 1 barang masuk. Null kalau tagihan tanpa barang masuk.
export async function fetchGoodsReceiptForBill(billId: string): Promise<GoodsReceiptForBill | null> {
  const { data: links, error } = await supabase
    .from("goods_note_billings")
    .select("goods_note_id")
    .eq("transaction_id", billId);
  if (error) throw new Error(error.message);
  const noteIds = [...new Set(((links ?? []) as { goods_note_id: string }[]).map((l) => l.goods_note_id))];
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

// Barang masuk alur baru milik 1 supplier yang belum ditagih -- bahan pilihan form "tagihan dari barang masuk".
export async function fetchUnbilledReceipts(supplierId: string): Promise<GoodsReceiptNote[]> {
  const { data, error } = await supabase
    .from("goods_notes_with_billing_status")
    .select("*")
    .eq("counterparty_id", supplierId)
    .eq("inbound_flow", "deferred")
    .eq("billing_status", "belum_tertagih")
    .order("note_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const notes = (data ?? []) as unknown as NoteRow[];
  const lines = await fetchLinesForNotes(notes.map((n) => n.id));
  return notes.map((n) => ({ ...n, goods_note_lines: lines.get(n.id) ?? [] }));
}

export function useUnbilledReceipts(supplierId: string) {
  return useQuery({
    queryKey: ["unbilled_goods_receipts", supplierId],
    queryFn: () => fetchUnbilledReceipts(supplierId),
    enabled: !!supplierId,
    staleTime: 5_000,
  });
}

export function useGoodsReceipts(filters: GoodsReceiptFilters) {
  return useQuery({
    queryKey: ["goods_receipt_notes", filters],
    queryFn: () => fetchGoodsReceipts(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
