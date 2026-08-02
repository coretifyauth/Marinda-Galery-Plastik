import type { Account } from "@/lib/accounts/schema";
import { fetchAccounts, fetchLinesBetween, fetchLinesUpTo } from "./balances";
import { computeIncomeStatement } from "./income-statement";
import { fetchClosingJournalEntryIds } from "./period-closing";
import { computeTrialBalance } from "./trial-balance";
import type { CashFlow, EntryLine, TrialBalance } from "./types";

/**
 * Kode akun Beban Penyusutan yang di-add-back di Operating — hardcode,
 * bukan derive generik (belum ada flag `is_depreciation` di `accounts`).
 * Ref: `memory/architecture/data/financial-reports-schema.md` bagian "Belum termasuk".
 */
const DEPRECIATION_ACCOUNT_CODES = ["5600", "5610"];
/** Kode akun utang jangka panjang (di luar Utang Usaha) yang mutasinya diklasifikasikan Financing. */
const FINANCING_LIABILITY_CODES = ["2200"];

function dayBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function childrenOf(accounts: Account[], parentCode: string): Account[] {
  const parent = accounts.find((a) => a.code === parentCode);
  if (!parent) return [];
  return accounts.filter((a) => a.parent_id === parent.id);
}

function sumByAccountIds(balances: TrialBalance["balances"], accountIds: Set<string>): number {
  return balances
    .filter((b) => accountIds.has(b.id))
    .reduce((sum, b) => sum + b.balance, 0);
}

/**
 * Klasifikasi Investing/Financing: cuma proses journal entry yang PUNYA
 * baris Kas (entry non-kas, mis. akuisisi aset via KUR langsung, dilewatin
 * total — itu yang bikin "non-cash investing/financing" = 0, bukan bug).
 * Baris non-kas di dalam entry yang lolos itu diklasifikasi lewat akun
 * lawannya: Aset Tetap non-kontra -> Investing, Ekuitas/Utang Bank -> Financing,
 * selain itu diabaikan (sudah kehitung di Operating lewat Laba Bersih/delta AR-Inv-AP).
 * Closing entry gak perlu di-exclude di sini secara eksplisit — dia gak pernah
 * punya baris Kas (cuma nyentuh Revenue/Expense/Equity), jadi otomatis kelewat
 * dari `hasKasLine` check di bawah.
 */
export function classifyInvestingFinancing(
  accounts: Account[],
  entryLines: EntryLine[]
): { investing: number; financing: number } {
  const kasAccountIds = new Set(childrenOf(accounts, "1000").map((a) => a.id));
  const fixedAssetAccountIds = new Set(
    childrenOf(accounts, "1600")
      .filter((a) => !a.is_contra)
      .map((a) => a.id)
  );
  const accountsById = new Map(accounts.map((a) => [a.id, a]));

  const byEntry = new Map<string, EntryLine[]>();
  for (const line of entryLines) {
    const list = byEntry.get(line.journal_entry_id) ?? [];
    list.push(line);
    byEntry.set(line.journal_entry_id, list);
  }

  let investing = 0;
  let financing = 0;

  for (const lines of byEntry.values()) {
    const hasKasLine = lines.some((l) => kasAccountIds.has(l.account_id));
    if (!hasKasLine) continue;

    for (const line of lines) {
      if (kasAccountIds.has(line.account_id)) continue;
      const account = accountsById.get(line.account_id);
      if (!account) continue;
      const contribution = line.credit - line.debit;

      if (fixedAssetAccountIds.has(line.account_id)) {
        investing += contribution;
      } else if (account.category === "equity" || FINANCING_LIABILITY_CODES.includes(account.code)) {
        financing += contribution;
      }
      // selain itu (revenue/expense/AR/Inventory/Utang Usaha): sudah kehitung di Operating, diabaikan di sini.
    }
  }

  return { investing, financing };
}

export function computeCashFlow(
  accounts: Account[],
  periodLines: EntryLine[],
  entryLines: EntryLine[],
  tbStart: TrialBalance,
  tbEnd: TrialBalance,
  startDate: string,
  endDate: string,
  closingEntryIds: ReadonlySet<string> = new Set()
): CashFlow {
  const incomeStatement = computeIncomeStatement(accounts, periodLines, startDate, endDate, closingEntryIds);

  const depreciationAddBack = incomeStatement.expenses
    .filter((b) => DEPRECIATION_ACCOUNT_CODES.includes(b.code))
    .reduce((sum, b) => sum + b.balance, 0);

  const arIds = new Set(accounts.filter((a) => a.code === "1300").map((a) => a.id));
  const inventoryIds = new Set(accounts.filter((a) => ["1400", "1420"].includes(a.code)).map((a) => a.id));
  const apIds = new Set(accounts.filter((a) => a.code === "2100").map((a) => a.id));
  const kasIds = new Set(childrenOf(accounts, "1000").map((a) => a.id));

  const deltaAccountsReceivable = sumByAccountIds(tbEnd.balances, arIds) - sumByAccountIds(tbStart.balances, arIds);
  const deltaInventory = sumByAccountIds(tbEnd.balances, inventoryIds) - sumByAccountIds(tbStart.balances, inventoryIds);
  const deltaAccountsPayable = sumByAccountIds(tbEnd.balances, apIds) - sumByAccountIds(tbStart.balances, apIds);

  const operating =
    incomeStatement.netIncome +
    depreciationAddBack -
    deltaAccountsReceivable -
    deltaInventory +
    deltaAccountsPayable;

  const { investing, financing } = classifyInvestingFinancing(accounts, entryLines);
  const netChange = operating + investing + financing;

  const beginningCash = sumByAccountIds(tbStart.balances, kasIds);
  const endingCash = sumByAccountIds(tbEnd.balances, kasIds);

  return {
    startDate,
    endDate,
    netIncome: incomeStatement.netIncome,
    depreciationAddBack,
    deltaAccountsReceivable,
    deltaInventory,
    deltaAccountsPayable,
    operating,
    investing,
    financing,
    netChange,
    beginningCash,
    endingCash,
  };
}

export async function getCashFlow(startDate: string, endDate: string): Promise<CashFlow> {
  const tbStartDate = dayBefore(startDate);
  const [accounts, periodEntryLines, tbStartRaw, tbEndRaw, closingEntryIds] = await Promise.all([
    fetchAccounts(),
    fetchLinesBetween(startDate, endDate),
    fetchLinesUpTo(tbStartDate),
    fetchLinesUpTo(endDate),
    fetchClosingJournalEntryIds(),
  ]);

  const tbStart = computeTrialBalance(accounts, tbStartRaw, tbStartDate);
  const tbEnd = computeTrialBalance(accounts, tbEndRaw, endDate);

  return computeCashFlow(
    accounts,
    periodEntryLines,
    periodEntryLines,
    tbStart,
    tbEnd,
    startDate,
    endDate,
    closingEntryIds
  );
}
