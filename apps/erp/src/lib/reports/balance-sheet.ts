import { getTrialBalance } from "./trial-balance";
import { sumBalances } from "./balances";
import type { BalanceSheet, TrialBalance } from "./types";

/**
 * Laba Ditahan di sini SELALU dihitung ulang dari Pendapatan-Beban yang
 * kumulatif sejak transaksi pertama (Trial Balance filter `<= asOfDate`
 * sudah otomatis kumulatif) — bukan dibaca dari akun `3200 Laba Ditahan`
 * yang gak pernah diposting (Period Closing formal belum ada, lihat
 * `memory/scope-debt/period-closing.md`).
 */
export function computeBalanceSheet(trialBalance: TrialBalance): BalanceSheet {
  const assets = trialBalance.balances.filter((b) => b.category === "asset");
  const liabilities = trialBalance.balances.filter((b) => b.category === "liability");
  const equity = trialBalance.balances.filter((b) => b.category === "equity");

  const revenueTotal = sumBalances(trialBalance.balances.filter((b) => b.category === "revenue"));
  const expenseTotal = sumBalances(trialBalance.balances.filter((b) => b.category === "expense"));
  const retainedEarnings = revenueTotal - expenseTotal;

  const totalAssets = sumBalances(assets);
  const totalLiabilities = sumBalances(liabilities);
  const totalEquity = sumBalances(equity) + retainedEarnings;

  return {
    asOfDate: trialBalance.asOfDate,
    assets,
    liabilities,
    equity,
    retainedEarnings,
    totalAssets,
    totalLiabilities,
    totalEquity,
  };
}

export async function getBalanceSheet(asOfDate: string): Promise<BalanceSheet> {
  const trialBalance = await getTrialBalance(asOfDate);
  return computeBalanceSheet(trialBalance);
}
