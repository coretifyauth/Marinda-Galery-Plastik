import { supabase } from "@/lib/supabase/client";

export const DEFAULT_LEDGER_PAGE_SIZE = 25;
export const LEDGER_PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

export type LedgerLine = {
  id: string;
  debit: number;
  credit: number;
  journal_entries: {
    entry_date: string;
    description: string | null;
    source_ref: string;
  };
};

export type LedgerPage = {
  rows: LedgerLine[];
  total: number;
  openingBalance: { debit: number; credit: number };
};

const SELECT_COLUMNS = "id, debit, credit, journal_entries!inner(entry_date, description, source_ref)";

/**
 * 1 halaman histori transaksi 1 akun + saldo pembuka (opening balance) sebelum halaman ini —
 * dipakai `/general-ledger` dan tab Ledger `/accounts/[id]`. Beda dari Trial Balance dkk
 * (`balances.ts`) yang cuma butuh 1 angka total per akun — di sini tiap baris transaksi HARUS
 * ditampilkan apa adanya (buat saldo berjalan per baris), jadi gak bisa diagregat abis jadi 1
 * angka. Fix-nya: query di-paginate (`.range()`, gak pernah ambil >1 pageSize baris sekaligus,
 * jauh di bawah `max_rows` di `supabase/config.toml`) + RPC
 * `report_account_ledger_opening_balance` (SUM baris SEBELUM halaman ini, dihitung di database)
 * buat nge-seed saldo berjalan di baris pertama halaman — bukan mulai dari 0.
 *
 * PENTING: order (`entry_date` lalu `id` sebagai tie-breaker) di query halaman ini HARUS PERSIS
 * SAMA dengan urutan yang dipakai RPC opening balance (`supabase/migrations/
 * 0041_report_account_ledger_opening_balance_rpc.sql`) — kalau enggak, offset "N baris sebelum
 * halaman ini" gak nyambung sama baris yang beneran ditampilkan, saldo berjalan bisa salah tanpa
 * error apa pun. Ref: `memory/scope-debt/journal-lines-unbounded-aggregate.md`.
 */
export async function fetchAccountLedgerPage(
  accountId: string,
  asOfDate: string,
  page: number,
  pageSize: number
): Promise<LedgerPage> {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const [pageResult, openingResult] = await Promise.all([
    supabase
      .from("journal_lines")
      .select(SELECT_COLUMNS, { count: "exact" })
      .eq("account_id", accountId)
      .lte("journal_entries.entry_date", asOfDate)
      .order("entry_date", { referencedTable: "journal_entries", ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
    supabase.rpc("report_account_ledger_opening_balance", {
      p_account_id: accountId,
      p_as_of: asOfDate,
      p_before_offset: from,
    }),
  ]);

  if (pageResult.error) throw new Error(pageResult.error.message);
  if (openingResult.error) throw new Error(openingResult.error.message);

  const openingRow = (openingResult.data as { debit: number; credit: number }[] | null)?.[0];

  return {
    rows: (pageResult.data ?? []) as unknown as LedgerLine[],
    total: pageResult.count ?? 0,
    openingBalance: openingRow ?? { debit: 0, credit: 0 },
  };
}
