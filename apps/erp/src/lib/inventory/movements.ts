import { supabase } from "@/lib/supabase/client";

export const DEFAULT_MOVEMENT_PAGE_SIZE = 25;
export const MOVEMENT_PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

export type ItemMovement = {
  id: string;
  movement_date: string;
  qty: number;
  source_label: string;
  source_ref: string | null;
};

export type MovementPage = {
  rows: ItemMovement[];
  total: number;
  openingBalance: number;
};

const SELECT_COLUMNS = "id, movement_date, qty, source_label, source_ref";

/**
 * 1 halaman Kartu Stok, TERBARU DULU (`movement_date`+`id` descending) — beda dari General Ledger
 * (`fetchAccountLedgerPage`, ascending) karena kebutuhan UI-nya kartu stok cuma peduli aktivitas
 * terakhir. Baca dari view `inventory_movements_with_source` (migration `0052`, LEFT JOIN ke 11
 * kemungkinan tabel sumber + COALESCE jadi label+ref manusiawi) — bukan tabel `inventory_movements`
 * mentah, biar gak perlu 11 embed nested di query ini.
 *
 * `openingBalance` tetap berarti "saldo tepat sebelum baris TERTUA di halaman ini" (sama makna
 * kayak General Ledger) walau baris tertua itu sekarang ada di UJUNG array, bukan awal — komponen
 * pemanggil yang balikin urutan buat ngitung saldo berjalan lalu balikin lagi buat tampil. Baris
 * tertua di halaman ini punya posisi ascending `total - from - rows.length` (total baris DIKURANGI
 * baris yang lebih baru di halaman-halaman sebelumnya DIKURANGI baris di halaman ini sendiri) —
 * itu offset yang dikirim ke RPC `report_item_movement_opening_balance` (ascending, gak diubah).
 * Reuse RPC yang ada, gak perlu RPC baru.
 */
export async function fetchItemMovementPage(
  itemId: string,
  asOfDate: string,
  page: number,
  pageSize: number
): Promise<MovementPage> {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const pageResult = await supabase
    .from("inventory_movements_with_source")
    .select(SELECT_COLUMNS, { count: "exact" })
    .eq("item_id", itemId)
    .lte("movement_date", asOfDate)
    .order("movement_date", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (pageResult.error) throw new Error(pageResult.error.message);
  const total = pageResult.count ?? 0;
  const rows = (pageResult.data ?? []) as unknown as ItemMovement[];
  const beforeOffset = Math.max(0, total - from - rows.length);

  const openingResult =
    beforeOffset > 0
      ? await supabase.rpc("report_item_movement_opening_balance", {
          p_item_id: itemId,
          p_as_of: asOfDate,
          p_before_offset: beforeOffset,
        })
      : { data: 0, error: null };

  if (openingResult.error) throw new Error(openingResult.error.message);

  return {
    rows,
    total,
    openingBalance: (openingResult.data as number | null) ?? 0,
  };
}
