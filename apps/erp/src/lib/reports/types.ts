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
  /** `balances` + akun header (rollup dari leaf child lewat `parent_id`) — cuma buat tampilan tree. */
  rolledBalances: AccountBalance[];
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

/** 1 baris delta akun neraca operasional (non-kas, non-Investing, non-Financing) di Cash Flow. */
export type OperatingWorkingCapitalLine = {
  accountId: string;
  code: string;
  name: string;
  /** Perubahan saldo akun itu sendiri (arah `normal_balance`-nya), end - start. */
  delta: number;
  /** Kontribusi ke Kas Bersih Operating — asset: -delta, liability: +delta. */
  contribution: number;
};

export type CashFlow = {
  startDate: string;
  endDate: string;
  netIncome: number;
  depreciationAddBack: number;
  /**
   * Delta tiap akun neraca operasional (asset/liability selain Kas, Aset Tetap,
   * dan akun Financing hardcode) yang bergerak di periode ini — auto-discover
   * dari `accounts`, BUKAN daftar kode akun hardcode. Ref: `memory/architecture/data/financial-reports-schema.md`.
   */
  operatingWorkingCapital: OperatingWorkingCapitalLine[];
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
  beginningCash: number;
  endingCash: number;
};
