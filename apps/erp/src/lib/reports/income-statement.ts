import type { Account } from "@/lib/accounts/schema";
import { computeAccountBalances, fetchAccountBalancesBetween, fetchAccounts, sumBalances } from "./balances";
import { fetchClosingJournalEntryIds } from "./period-closing";
import type { EntryLine, IncomeStatement } from "./types";

/**
 * `excludeClosingEntryIds` — baris yang berasal dari closing entry (`period_closings.journal_entry_id`)
 * gak boleh ikut dihitung. Closing entry bertanggal `end_date` periode yang ditutup, jadi kalau
 * rentang yang di-query persis sama dengan periode yang baru ditutup, baris penolan Revenue/
 * Expense-nya sendiri bakal ikut kehitung dan membatalkan balik angka yang baru dinolkan —
 * hasilnya 0 padahal harusnya angka historis periode itu (`memory/scope-debt/
 * income-statement-closing-entry-self-cancel.md`). Trial Balance SENGAJA gak exclude ini (lihat
 * `trial-balance.ts`) — TB butuh efek closing entry buat nunjukin saldo Revenue/Expense yang
 * emang udah ke-nol-in secara kumulatif.
 */
export function computeIncomeStatement(
  accounts: Account[],
  lines: EntryLine[],
  startDate: string,
  endDate: string,
  excludeClosingEntryIds: ReadonlySet<string> = new Set()
): IncomeStatement {
  const filteredLines =
    excludeClosingEntryIds.size === 0
      ? lines
      : lines.filter((l) => !excludeClosingEntryIds.has(l.journal_entry_id));

  const balances = computeAccountBalances(accounts, filteredLines);
  const revenues = balances.filter((b) => b.category === "revenue");
  const expenses = balances.filter((b) => b.category === "expense");
  const totalRevenue = sumBalances(revenues);
  const totalExpense = sumBalances(expenses);

  return {
    startDate,
    endDate,
    revenues,
    expenses,
    totalRevenue,
    totalExpense,
    netIncome: totalRevenue - totalExpense,
  };
}

export async function getIncomeStatement(startDate: string, endDate: string): Promise<IncomeStatement> {
  const [accounts, closingEntryIds] = await Promise.all([fetchAccounts(), fetchClosingJournalEntryIds()]);
  const lines = await fetchAccountBalancesBetween(startDate, endDate, closingEntryIds);
  // Exclude closing entry udah kejadian di RPC (SQL), jadi filter di computeIncomeStatement dikosongkan (no-op).
  return computeIncomeStatement(accounts, lines, startDate, endDate, new Set());
}
