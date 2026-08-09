import type { Account } from "@/lib/accounts/schema";

/** Baris `journal_lines` yang relevan buat laporan — cuma kolom yang dipakai reduce. */
export type ReportLine = {
  account_id: string;
  debit: number;
  credit: number;
};

/** `ReportLine` + `journal_entry_id` — dibutuhkan tiap kali laporan perlu tau baris itu bagian dari entry mana (mis. exclude closing entry, atau group per entry buat Cash Flow). */
export type EntryLine = ReportLine & { journal_entry_id: string };

/** Saldo 1 akun hasil reduce `ReportLine[]`, arah sesuai `normal_balance` akun itu sendiri. */
export type AccountBalance = Account & { balance: number };

export type TrialBalance = {
  asOfDate: string;
  balances: AccountBalance[];
  totalDebit: number;
  totalCredit: number;
};

export type IncomeStatement = {
  startDate: string;
  endDate: string;
  revenues: AccountBalance[];
  expenses: AccountBalance[];
  totalRevenue: number;
  totalExpense: number;
  netIncome: number;
};

export type BalanceSheet = {
  asOfDate: string;
  assets: AccountBalance[];
  liabilities: AccountBalance[];
  equity: AccountBalance[];
  retainedEarnings: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
};

export type CashFlow = {
  startDate: string;
  endDate: string;
  netIncome: number;
  depreciationAddBack: number;
  deltaAccountsReceivable: number;
  deltaInventory: number;
  deltaAccountsPayable: number;
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
  beginningCash: number;
  endingCash: number;
};
