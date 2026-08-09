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

/** Baris jurnal dengan `entry_date <= asOfDate` — bahan Trial Balance. */
export async function fetchLinesUpTo(asOfDate: string): Promise<ReportLine[]> {
  const { data, error } = await supabase
    .from("journal_lines")
    .select("account_id, debit, credit, journal_entries!inner(entry_date)")
    .lte("journal_entries.entry_date", asOfDate);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ReportLine[];
}

/**
 * Baris jurnal dengan `startDate <= entry_date <= endDate` — bahan Income Statement/Cash Flow.
 * Include `journal_entry_id` (beda dari `fetchLinesUpTo`) — Income Statement butuh ini buat
 * exclude baris closing entry (`period-closing.ts` bagian `fetchClosingJournalEntryIds`,
 * ref `memory/scope-debt/income-statement-closing-entry-self-cancel.md`), Cash Flow butuh
 * buat group baris per entry (`classifyInvestingFinancing`).
 */
export async function fetchLinesBetween(startDate: string, endDate: string): Promise<EntryLine[]> {
  const { data, error } = await supabase
    .from("journal_lines")
    .select("journal_entry_id, account_id, debit, credit, journal_entries!inner(entry_date)")
    .gte("journal_entries.entry_date", startDate)
    .lte("journal_entries.entry_date", endDate);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as EntryLine[];
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
