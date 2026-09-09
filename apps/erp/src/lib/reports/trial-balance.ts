import type { Account } from "@/lib/accounts/schema";
import { computeAccountBalances, fetchAccounts, fetchLinesUpTo, rollupAccountBalances } from "./balances";
import type { ReportLine, TrialBalance } from "./types";

/**
 * Trial Balance murni pure — dipisah dari `getTrialBalance` biar bisa
 * dites tanpa network (`docs/architecture/financial-reports-schema.md`).
 */
export function computeTrialBalance(
  accounts: Account[],
  lines: ReportLine[],
  asOfDate: string
): TrialBalance {
  const balances = computeAccountBalances(accounts, lines);
  const totalDebit = balances
    .filter((b) => b.normal_balance === "debit")
    .reduce((sum, b) => sum + b.balance, 0);
  const totalCredit = balances
    .filter((b) => b.normal_balance === "credit")
    .reduce((sum, b) => sum + b.balance, 0);
  const rolledBalances = rollupAccountBalances(accounts, balances);

  return { asOfDate, balances, rolledBalances, totalDebit, totalCredit };
}

export async function getTrialBalance(asOfDate: string): Promise<TrialBalance> {
  const [accounts, lines] = await Promise.all([fetchAccounts(), fetchLinesUpTo(asOfDate)]);
  return computeTrialBalance(accounts, lines, asOfDate);
}
