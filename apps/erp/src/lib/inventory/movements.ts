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
 * 1 halaman Kartu Stok (riwayat mutasi kronologis 1 item) + saldo berjalan (opening balance)
 * sebelum halaman ini — mirror persis `fetchAccountLedgerPage` (`lib/reports/ledger.ts`, General
 * Ledger). Baca dari view `inventory_movements_with_source` (migration `0052`, LEFT JOIN ke 11
 * kemungkinan tabel sumber + COALESCE jadi label+ref manusiawi) — bukan tabel `inventory_movements`
 * mentah, biar gak perlu 11 embed nested di query ini.
 *
 * Saldo berjalan per BARIS dihitung di komponen pemanggil (cumulative sum dari `openingBalance`),
 * BUKAN di sini — pola sama persis General Ledger, `MovementPage` cuma nyimpen data mentah +
 * 1 angka opening balance.
 *
 * PENTING: order (`movement_date` lalu `id`) di query halaman ini HARUS PERSIS SAMA dengan urutan
 * yang dipakai RPC opening balance (`report_item_movement_opening_balance`, migration `0052`) —
 * kalau enggak, offset "N baris sebelum halaman ini" gak nyambung sama baris yang beneran
 * ditampilkan, saldo berjalan bisa salah tanpa error apa pun (pelajaran sama seperti General
 * Ledger, `memory/scope-debt/journal-lines-unbounded-aggregate.md`).
 */
export async function fetchItemMovementPage(
  itemId: string,
  asOfDate: string,
  page: number,
  pageSize: number
): Promise<MovementPage> {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const [pageResult, openingResult] = await Promise.all([
    supabase
      .from("inventory_movements_with_source")
      .select(SELECT_COLUMNS, { count: "exact" })
      .eq("item_id", itemId)
      .lte("movement_date", asOfDate)
      .order("movement_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
    supabase.rpc("report_item_movement_opening_balance", {
      p_item_id: itemId,
      p_as_of: asOfDate,
      p_before_offset: from,
    }),
  ]);

  if (pageResult.error) throw new Error(pageResult.error.message);
  if (openingResult.error) throw new Error(openingResult.error.message);

  return {
    rows: (pageResult.data ?? []) as unknown as ItemMovement[],
    total: pageResult.count ?? 0,
    openingBalance: (openingResult.data as number | null) ?? 0,
  };
}
