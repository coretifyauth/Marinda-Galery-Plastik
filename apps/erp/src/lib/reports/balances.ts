import { supabase } from "@/lib/supabase/client";
import type { Account } from "@/lib/accounts/schema";
import type { AccountBalance, EntryLine, ReportLine } from "./types";

const ACCOUNT_COLUMNS = "id, code, name, category, normal_balance, is_contra, parent_id, archived_at";

/**
 * Reduce `ReportLine[]` jadi saldo per akun. Arah saldo (debit-credit vs
 * credit-debit) ngikutin `normal_balance` masing-masing akun — sama rumus
 * yang dipakai tab Ledger `/accounts/[id]`. Akun yang gak pernah punya baris
 * (termasuk akun header — leaf-only posting rule) gak muncul di hasil.
 */
export function computeAccountBalances(accounts: Account[], lines: ReportLine[]): AccountBalance[] {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const t = totals.get(line.account_id) ?? { debit: 0, credit: 0 };
    t.debit += line.debit;
    t.credit += line.credit;
    totals.set(line.account_id, t);
  }

  const balances: AccountBalance[] = [];
  for (const account of accounts) {
    const t = totals.get(account.id);
    if (!t) continue;
    const balance = account.normal_balance === "debit" ? t.debit - t.credit : t.credit - t.debit;
    balances.push({ ...account, balance });
  }
  return balances;
}

export async function fetchAccounts(): Promise<Account[]> {
  const { data, error } = await supabase.from("accounts").select(ACCOUNT_COLUMNS);
  if (error) throw new Error(error.message);
  return (data ?? []) as Account[];
}

/**
 * Saldo per akun (`entry_date <= asOfDate`) — bahan Trial Balance/Balance Sheet, juga
 * `tbStart`/`tbEnd` di Cash Flow. Lewat RPC `report_account_balances_up_to` (SUM/GROUP BY
 * di database), BUKAN fetch raw `journal_lines` lalu reduce di JS — query ini kumulatif
 * sejak transaksi pertama, jadi paling rawan kena `max_rows` PostgREST (`supabase/config.toml`)
 * begitu data tumbuh. Ref: `memory/scope-debt/journal-lines-unbounded-aggregate.md`.
 */
export async function fetchLinesUpTo(asOfDate: string): Promise<ReportLine[]> {
  const { data, error } = await supabase.rpc("report_account_balances_up_to", { p_as_of: asOfDate });
  if (error) throw new Error(error.message);
  return (data ?? []) as ReportLine[];
}

/**
 * Saldo per akun (`startDate <= entry_date <= endDate`, closing entry dikecualikan) — bahan
 * Income Statement DAN Cash Flow (lewat `computeIncomeStatement` internal di `computeCashFlow`).
 * Lewat RPC `report_account_balances_between` (SUM/GROUP BY + exclude closing entry, dua-duanya
 * di database) — cuma butuh total per akun, gak butuh tau baris per `journal_entry_id` (beda
 * dari kebutuhan `classifyInvestingFinancing` di Cash Flow, yang sekarang punya RPC sendiri:
 * `fetchInvestingFinancing`/`report_cash_flow_investing_financing` di `cash-flow.ts`).
 * Ref: `memory/scope-debt/journal-lines-unbounded-aggregate.md`.
 *
 * `journal_entry_id` di hasilnya diisi `""` — placeholder biar tetap satisfy tipe `EntryLine`
 * yang dipakai `computeIncomeStatement` (buat filter-by-journal_entry_id-nya sendiri). Exclude
 * closing entry SUDAH kejadian di SQL, jadi placeholder itu gak akan pernah dicocokkan/dibaca
 * lagi buat filtering.
 */
export async function fetchAccountBalancesBetween(
  startDate: string,
  endDate: string,
  excludeEntryIds: ReadonlySet<string> = new Set()
): Promise<EntryLine[]> {
  const { data, error } = await supabase.rpc("report_account_balances_between", {
    p_start_date: startDate,
    p_end_date: endDate,
    p_exclude_entry_ids: Array.from(excludeEntryIds),
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ReportLine[]).map((row) => ({ ...row, journal_entry_id: "" }));
}

/**
 * Total 1 kategori (Total Asset, Total Revenue, dst). Akun kontra (`is_contra`)
 * disimpan positif ke arah `normal_balance`-nya sendiri (kredit buat kontra-asset)
 * — makanya di sini harus DIKURANGKAN, bukan ditambah, biar "Akumulasi Penyusutan"
 * benar-benar mengurangi Total Aset, bukan malah menambah. Beda dari total kolom
 * Trial Balance (`trial-balance.ts`), yang emang harus tetap masuk sisi kreditnya
 * apa adanya (kontra tetap tampil sebagai baris kredit di Trial Balance).
 */
export function sumBalances(balances: AccountBalance[]): number {
  return balances.reduce((sum, b) => sum + (b.is_contra ? -b.balance : b.balance), 0);
}

/**
 * Rollup saldo akun header (mis. "1000 Kas") dari total leaf child-nya lewat
 * `parent_id`, rekursif (header bisa punya header lagi). Kontra tetap
 * dikurangkan ke parent-nya, sama aturan `sumBalances`. Header tanpa
 * transaksi aktif di child-nya gak ikut muncul (balance 0 di-filter), sama
 * kayak leaf tanpa transaksi. Cuma buat TAMPILAN — total kolom Debit/Kredit
 * Trial Balance tetap dari leaf doang (`computeTrialBalance`), biar gak
 * dobel-hitung (`memory/scope-debt/trial-balance-rollup.md`).
 */
export function rollupAccountBalances(accounts: Account[], leafBalances: AccountBalance[]): AccountBalance[] {
  const direct = new Map(leafBalances.map((b) => [b.id, b.balance]));
  const childrenOf = new Map<string, Account[]>();
  for (const a of accounts) {
    if (!a.parent_id) continue;
    const list = childrenOf.get(a.parent_id) ?? [];
    list.push(a);
    childrenOf.set(a.parent_id, list);
  }

  const resolved = new Map<string, number>();
  function resolve(a: Account): number {
    const cached = resolved.get(a.id);
    if (cached !== undefined) return cached;
    const children = childrenOf.get(a.id) ?? [];
    const total =
      children.length > 0
        ? children.reduce((sum, c) => sum + (c.is_contra ? -resolve(c) : resolve(c)), 0)
        : (direct.get(a.id) ?? 0);
    resolved.set(a.id, total);
    return total;
  }

  return accounts.map((a) => ({ ...a, balance: resolve(a) })).filter((a) => a.balance !== 0);
}

/** Kedalaman akun di hirarki `parent_id`, buat indentasi tampilan tree. */
export function accountDepth(account: Account, accounts: Account[]): number {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let depth = 0;
  let current = account;
  while (current.parent_id) {
    const parent = byId.get(current.parent_id);
    if (!parent) break;
    depth++;
    current = parent;
  }
  return depth;
}
