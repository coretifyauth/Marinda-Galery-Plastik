import { supabase } from "@/lib/supabase/client";
import type { Account } from "@/lib/accounts/schema";
import { fetchAccountBalancesBetween, fetchAccounts, fetchLinesUpTo } from "./balances";
import { computeIncomeStatement } from "./income-statement";
import { fetchClosingJournalEntryIds } from "./period-closing";
import { computeTrialBalance } from "./trial-balance";
import type { CashFlow, EntryLine, OperatingWorkingCapitalLine, TrialBalance } from "./types";

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
 * Delta tiap akun neraca "operasional" (asset/liability) antara 2 titik waktu —
 * auto-discover dari `accounts`, BUKAN daftar kode akun hardcode (AR/Inventory/AP
 * lama). Excluded: Kas (sudah dipisah sebagai Kas Awal/Akhir), seluruh keluarga
 * Aset Tetap termasuk kontra-nya (non-kontra sudah kehitung di Investing lewat
 * `classifyInvestingFinancing`, kontra/Akumulasi Penyusutan sudah kehitung lewat
 * `depreciationAddBack` — includeIn di sini bakal double-count keduanya), dan akun
 * liability yang di-hardcode Financing (`FINANCING_LIABILITY_CODES`). Sisanya
 * (Piutang Usaha, Persediaan, Utang Usaha, dan akun neraca baru mana pun ke depan
 * kayak Uang Muka/PPN/Piutang Retur) otomatis ke-track tanpa perlu edit kode ini lagi.
 * Ref bug yang ditutup: `Kas Awal + Operating + Investing + Financing != Kas Akhir`
 * begitu ada akun neraca baru yang gak ada di daftar hardcode lama.
 */
function operatingWorkingCapitalDeltas(
  accounts: Account[],
  tbStart: TrialBalance,
  tbEnd: TrialBalance
): OperatingWorkingCapitalLine[] {
  const kasAccountIds = new Set(childrenOf(accounts, "1000").map((a) => a.id));
  const fixedAssetFamilyIds = new Set(childrenOf(accounts, "1600").map((a) => a.id));
  const startById = new Map(tbStart.balances.map((b) => [b.id, b.balance]));
  const endById = new Map(tbEnd.balances.map((b) => [b.id, b.balance]));

  const lines: OperatingWorkingCapitalLine[] = [];
  for (const account of accounts) {
    if (account.category !== "asset" && account.category !== "liability") continue;
    if (kasAccountIds.has(account.id)) continue;
    if (fixedAssetFamilyIds.has(account.id)) continue;
    if (account.category === "liability" && FINANCING_LIABILITY_CODES.includes(account.code)) continue;

    const delta = (endById.get(account.id) ?? 0) - (startById.get(account.id) ?? 0);
    if (delta === 0) continue;

    const contribution = account.normal_balance === "debit" ? -delta : delta;
    lines.push({ accountId: account.id, code: account.code, name: account.name, delta, contribution });
  }
  return lines;
}

/**
 * Klasifikasi Investing/Financing: cuma proses journal entry yang PUNYA
 * baris Kas (entry non-kas, mis. akuisisi aset via KUR langsung, dilewatin
 * total — itu yang bikin "non-cash investing/financing" = 0, bukan bug).
 * Baris non-kas di dalam entry yang lolos itu diklasifikasi lewat akun
 * lawannya: Aset Tetap non-kontra -> Investing, Ekuitas/Utang Bank -> Financing,
 * selain itu diabaikan (sudah kehitung di Operating lewat `operatingWorkingCapitalDeltas`).
 * Closing entry gak perlu di-exclude di sini secara eksplisit — dia gak pernah
 * punya baris Kas (cuma nyentuh Revenue/Expense/Equity), jadi otomatis kelewat
 * dari `hasKasLine` check di bawah.
 *
 * CATATAN (2026-08-17): fungsi ini SEKARANG HANYA dipakai sebagai reference
 * implementation buat test (`reports.test.ts`) — butuh raw per-baris `journal_lines`
 * yang dikelompokkan per `journal_entry_id`, gak bisa diagregat jadi 1 angka total
 * di database lewat SUM/GROUP BY biasa (beda dari Trial Balance/Income Statement,
 * `memory/scope-debt/journal-lines-unbounded-aggregate.md`). Di production,
 * `getCashFlow` manggil RPC `report_cash_flow_investing_financing`
 * (`supabase/migrations/0040_report_cash_flow_investing_financing_rpc.sql`) yang
 * isinya replikasi PERSIS logic di bawah ini di SQL. Kalau logic klasifikasi di sini
 * berubah (kode akun Kas/Aset Tetap/`FINANCING_LIABILITY_CODES`), WAJIB dibuat
 * migration baru yang mirror perubahannya — gak ada mekanisme otomatis yang jaga
 * 2 tempat ini tetap sinkron.
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
      // selain itu (revenue/expense/akun neraca operasional): sudah kehitung di Operating, diabaikan di sini.
    }
  }

  return { investing, financing };
}

/** RPC-based counterpart ke `classifyInvestingFinancing` — dipakai `getCashFlow`, lihat catatan di atas fungsi itu. */
export async function fetchInvestingFinancing(
  startDate: string,
  endDate: string
): Promise<{ investing: number; financing: number }> {
  const { data, error } = await supabase.rpc("report_cash_flow_investing_financing", {
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw new Error(error.message);
  const row = (data as { investing: number; financing: number }[] | null)?.[0];
  return row ?? { investing: 0, financing: 0 };
}

export function computeCashFlow(
  accounts: Account[],
  periodLines: EntryLine[],
  investingFinancing: { investing: number; financing: number },
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

  const kasIds = new Set(childrenOf(accounts, "1000").map((a) => a.id));

  const operatingWorkingCapital = operatingWorkingCapitalDeltas(accounts, tbStart, tbEnd);
  const workingCapitalContribution = operatingWorkingCapital.reduce((sum, l) => sum + l.contribution, 0);

  const operating = incomeStatement.netIncome + depreciationAddBack + workingCapitalContribution;

  const { investing, financing } = investingFinancing;
  const netChange = operating + investing + financing;

  const beginningCash = sumByAccountIds(tbStart.balances, kasIds);
  const endingCash = sumByAccountIds(tbEnd.balances, kasIds);

  return {
    startDate,
    endDate,
    netIncome: incomeStatement.netIncome,
    depreciationAddBack,
    operatingWorkingCapital,
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
  const [accounts, closingEntryIds, tbStartRaw, tbEndRaw, investingFinancing] = await Promise.all([
    fetchAccounts(),
    fetchClosingJournalEntryIds(),
    fetchLinesUpTo(tbStartDate),
    fetchLinesUpTo(endDate),
    fetchInvestingFinancing(startDate, endDate),
  ]);
  const periodLines = await fetchAccountBalancesBetween(startDate, endDate, closingEntryIds);

  const tbStart = computeTrialBalance(accounts, tbStartRaw, tbStartDate);
  const tbEnd = computeTrialBalance(accounts, tbEndRaw, endDate);

  return computeCashFlow(
    accounts,
    periodLines,
    investingFinancing,
    tbStart,
    tbEnd,
    startDate,
    endDate,
    new Set()
  );
}
