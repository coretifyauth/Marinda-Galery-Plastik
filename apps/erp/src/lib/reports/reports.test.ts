import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/accounts/schema";
import { computeAccountBalances, rollupAccountBalances, sumBalances } from "./balances";
import { computeTrialBalance } from "./trial-balance";
import { computeIncomeStatement } from "./income-statement";
import { computeBalanceSheet } from "./balance-sheet";
import { computeCashFlow, classifyInvestingFinancing } from "./cash-flow";
import type { EntryLine } from "./types";

/**
 * Fixture = contoh angka lengkap di `docs/domain/financial-reports.md`
 * ("Contoh Angka Lengkap, 1 Periode, Tervalidasi End-to-End"), bukan data
 * acak — jadi hasil tes ini langsung ke-cross-check ke angka yang udah
 * divalidasi manual di domain doc. Modal awal + Kas 10.000.000 diposting
 * sebelum periode (Juni), 7 transaksi lain diposting sepanjang Juli 2026.
 */
function account(partial: Partial<Account> & Pick<Account, "code" | "category" | "normal_balance">): Account {
  return {
    id: partial.code,
    name: partial.code,
    is_contra: false,
    parent_id: null,
    archived_at: null,
    ...partial,
  };
}

const kasHeader = account({ code: "1000", name: "Kas", category: "asset", normal_balance: "debit" });
const kas = account({ code: "1100", category: "asset", normal_balance: "debit", parent_id: "1000" });
const piutang = account({ code: "1300", category: "asset", normal_balance: "debit" });
const persediaan = account({ code: "1400", category: "asset", normal_balance: "debit" });
const asetTetapHeader = account({ code: "1600", name: "Aset Tetap", category: "asset", normal_balance: "debit" });
const asetTetap = account({ code: "1610", category: "asset", normal_balance: "debit", parent_id: "1600" });
const akumulasiPenyusutan = account({
  code: "1630",
  category: "asset",
  normal_balance: "credit",
  is_contra: true,
  parent_id: "1600",
});
const utangUsaha = account({ code: "2100", category: "liability", normal_balance: "credit" });
const utangBank = account({ code: "2200", category: "liability", normal_balance: "credit" });
const modal = account({ code: "3100", category: "equity", normal_balance: "credit" });
const labaDitahan = account({ code: "3200", category: "equity", normal_balance: "credit" });
const pendapatan = account({ code: "4100", category: "revenue", normal_balance: "credit" });
const hpp = account({ code: "5100", category: "expense", normal_balance: "debit" });
const bebanGaji = account({ code: "5200", category: "expense", normal_balance: "debit" });
const bebanPenyusutan = account({ code: "5600", category: "expense", normal_balance: "debit" });

const accounts: Account[] = [
  kasHeader,
  kas,
  piutang,
  persediaan,
  asetTetapHeader,
  asetTetap,
  akumulasiPenyusutan,
  utangUsaha,
  utangBank,
  modal,
  labaDitahan,
  pendapatan,
  hpp,
  bebanGaji,
  bebanPenyusutan,
];

type FixtureLine = EntryLine & { entry_date: string };

const openingLines: FixtureLine[] = [
  { journal_entry_id: "e0-a", account_id: kas.id, debit: 10_000_000, credit: 0, entry_date: "2026-06-01" },
  { journal_entry_id: "e0-b", account_id: modal.id, debit: 0, credit: 10_000_000, entry_date: "2026-06-01" },
];

const periodLines: FixtureLine[] = [
  // 1. Beli aset tetap, non-cash (langsung Utang Bank)
  { journal_entry_id: "e1", account_id: asetTetap.id, debit: 15_000_000, credit: 0, entry_date: "2026-07-05" },
  { journal_entry_id: "e1", account_id: utangBank.id, debit: 0, credit: 15_000_000, entry_date: "2026-07-05" },
  // 2. Beli bahan baku, separuh cash separuh utang
  { journal_entry_id: "e2", account_id: persediaan.id, debit: 3_000_000, credit: 0, entry_date: "2026-07-06" },
  { journal_entry_id: "e2", account_id: kas.id, debit: 0, credit: 1_500_000, entry_date: "2026-07-06" },
  { journal_entry_id: "e2", account_id: utangUsaha.id, debit: 0, credit: 1_500_000, entry_date: "2026-07-06" },
  // 3. Jual barang, separuh cash separuh piutang
  { journal_entry_id: "e3", account_id: kas.id, debit: 4_000_000, credit: 0, entry_date: "2026-07-10" },
  { journal_entry_id: "e3", account_id: piutang.id, debit: 4_000_000, credit: 0, entry_date: "2026-07-10" },
  { journal_entry_id: "e3", account_id: pendapatan.id, debit: 0, credit: 8_000_000, entry_date: "2026-07-10" },
  // 4. HPP atas penjualan itu
  { journal_entry_id: "e4", account_id: hpp.id, debit: 2_000_000, credit: 0, entry_date: "2026-07-10" },
  { journal_entry_id: "e4", account_id: persediaan.id, debit: 0, credit: 2_000_000, entry_date: "2026-07-10" },
  // 5. Bayar gaji cash
  { journal_entry_id: "e5", account_id: bebanGaji.id, debit: 1_500_000, credit: 0, entry_date: "2026-07-15" },
  { journal_entry_id: "e5", account_id: kas.id, debit: 0, credit: 1_500_000, entry_date: "2026-07-15" },
  // 6. Penyusutan aset tetap bulan ini
  { journal_entry_id: "e6", account_id: bebanPenyusutan.id, debit: 250_000, credit: 0, entry_date: "2026-07-20" },
  { journal_entry_id: "e6", account_id: akumulasiPenyusutan.id, debit: 0, credit: 250_000, entry_date: "2026-07-20" },
  // 7. Bayar sebagian Utang Usaha cash
  { journal_entry_id: "e7", account_id: utangUsaha.id, debit: 500_000, credit: 0, entry_date: "2026-07-25" },
  { journal_entry_id: "e7", account_id: kas.id, debit: 0, credit: 500_000, entry_date: "2026-07-25" },
];

const allLines = [...openingLines, ...periodLines];

function linesUpTo(date: string): FixtureLine[] {
  return allLines.filter((l) => l.entry_date <= date);
}
function linesBetween(start: string, end: string): FixtureLine[] {
  return allLines.filter((l) => l.entry_date >= start && l.entry_date <= end);
}

describe("computeAccountBalances", () => {
  it("ignores accounts that never received a posting (incl. header accounts)", () => {
    const balances = computeAccountBalances(accounts, linesUpTo("2026-07-31"));
    const codes = balances.map((b) => b.code);
    expect(codes).not.toContain("1000");
    expect(codes).not.toContain("1600");
  });
});

describe("computeTrialBalance — angka domain doc", () => {
  const tb = computeTrialBalance(accounts, linesUpTo("2026-07-31"), "2026-07-31");
  const byCode = (code: string) => tb.balances.find((b) => b.code === code)?.balance;

  it("matches per-account balances from the worked example", () => {
    expect(byCode("1100")).toBe(10_500_000);
    expect(byCode("1300")).toBe(4_000_000);
    expect(byCode("1400")).toBe(1_000_000);
    expect(byCode("1610")).toBe(15_000_000);
    expect(byCode("1630")).toBe(250_000);
    expect(byCode("2100")).toBe(1_000_000);
    expect(byCode("2200")).toBe(15_000_000);
    expect(byCode("3100")).toBe(10_000_000);
    expect(byCode("4100")).toBe(8_000_000);
    expect(byCode("5100")).toBe(2_000_000);
    expect(byCode("5200")).toBe(1_500_000);
    expect(byCode("5600")).toBe(250_000);
  });

  it("balances (total debit = total credit = 34.250.000)", () => {
    expect(tb.totalDebit).toBe(34_250_000);
    expect(tb.totalCredit).toBe(34_250_000);
  });
});

describe("computeIncomeStatement", () => {
  const is = computeIncomeStatement(accounts, linesBetween("2026-07-01", "2026-07-31"), "2026-07-01", "2026-07-31");

  it("computes Laba Bersih = 4.250.000", () => {
    expect(is.totalRevenue).toBe(8_000_000);
    expect(is.totalExpense).toBe(3_750_000);
    expect(is.netIncome).toBe(4_250_000);
  });
});

describe("computeIncomeStatement — closing entry exclusion (memory/scope-debt/income-statement-closing-entry-self-cancel.md)", () => {
  // Closing entry buat Juli 2026, persis kayak yang bakal diposting close_period:
  // debit tiap akun Revenue (nol-in), kredit tiap akun Expense (nol-in), sisanya
  // (laba 4.250.000) kredit ke Laba Ditahan. Bertanggal end_date periode (31 Juli).
  const closingLines: FixtureLine[] = [
    { journal_entry_id: "closing-1", account_id: pendapatan.id, debit: 8_000_000, credit: 0, entry_date: "2026-07-31" },
    { journal_entry_id: "closing-1", account_id: hpp.id, debit: 0, credit: 2_000_000, entry_date: "2026-07-31" },
    { journal_entry_id: "closing-1", account_id: bebanGaji.id, debit: 0, credit: 1_500_000, entry_date: "2026-07-31" },
    { journal_entry_id: "closing-1", account_id: bebanPenyusutan.id, debit: 0, credit: 250_000, entry_date: "2026-07-31" },
    { journal_entry_id: "closing-1", account_id: labaDitahan.id, debit: 0, credit: 4_250_000, entry_date: "2026-07-31" },
  ];
  const linesWithClosing = [...linesBetween("2026-07-01", "2026-07-31"), ...closingLines];

  it("without exclusion, re-querying a just-closed period self-cancels to 0 (reproduces the bug)", () => {
    const is = computeIncomeStatement(accounts, linesWithClosing, "2026-07-01", "2026-07-31");
    expect(is.totalRevenue).toBe(0);
    expect(is.totalExpense).toBe(0);
    expect(is.netIncome).toBe(0);
  });

  it("with closing entry excluded, re-querying the same closed period returns the original historical figures", () => {
    const is = computeIncomeStatement(
      accounts,
      linesWithClosing,
      "2026-07-01",
      "2026-07-31",
      new Set(["closing-1"])
    );
    expect(is.totalRevenue).toBe(8_000_000);
    expect(is.totalExpense).toBe(3_750_000);
    expect(is.netIncome).toBe(4_250_000);
  });

  it("exclusion set doesn't affect a query for a different (open) range", () => {
    // 1-15 Juli: sebelum penyusutan (e6, 20 Juli) diposting — closing entry (31 Juli)
    // gak relevan sama sekali di rentang ini, exclusion set jadi no-op.
    const is = computeIncomeStatement(
      accounts,
      linesBetween("2026-07-01", "2026-07-15"),
      "2026-07-01",
      "2026-07-15",
      new Set(["closing-1"])
    );
    expect(is.totalRevenue).toBe(8_000_000);
    expect(is.totalExpense).toBe(3_500_000); // HPP 2.000.000 + Gaji 1.500.000, penyusutan (20 Juli) belum masuk
  });
});

describe("computeBalanceSheet", () => {
  const tb = computeTrialBalance(accounts, linesUpTo("2026-07-31"), "2026-07-31");
  const bs = computeBalanceSheet(tb);

  it("subtracts contra-asset from Total Assets instead of adding it", () => {
    // Kalau kontra ke-treat salah (ditambah bukan dikurang), ini akan jadi 30.750.000.
    expect(bs.totalAssets).toBe(30_250_000);
  });

  it("derives Laba Ditahan from cumulative Income Statement, not a posted account", () => {
    expect(bs.retainedEarnings).toBe(4_250_000);
    expect(bs.totalEquity).toBe(14_250_000);
  });

  it("balances: Total Asset = Total Liability + Total Equity", () => {
    expect(bs.totalLiabilities).toBe(16_000_000);
    expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity);
  });
});

describe("classifyInvestingFinancing", () => {
  it("treats a loan-financed asset purchase (no Kas line) as non-cash — 0 both sides", () => {
    const e1Lines = periodLines.filter((l) => l.journal_entry_id === "e1");
    const { investing, financing } = classifyInvestingFinancing(accounts, e1Lines);
    expect(investing).toBe(0);
    expect(financing).toBe(0);
  });
});

describe("computeCashFlow — angka domain doc", () => {
  const tbStart = computeTrialBalance(accounts, linesUpTo("2026-06-30"), "2026-06-30");
  const tbEnd = computeTrialBalance(accounts, linesUpTo("2026-07-31"), "2026-07-31");
  const cf = computeCashFlow(
    accounts,
    linesBetween("2026-07-01", "2026-07-31"),
    linesBetween("2026-07-01", "2026-07-31"),
    tbStart,
    tbEnd,
    "2026-07-01",
    "2026-07-31"
  );

  it("Operating = 500.000, Investing = 0 (non-cash acquisition)", () => {
    expect(cf.operating).toBe(500_000);
    expect(cf.investing).toBe(0);
    expect(cf.financing).toBe(0);
  });

  it("reconciles: Kas Awal + Kenaikan Kas = Kas Akhir (Trial Balance)", () => {
    expect(cf.beginningCash).toBe(10_000_000);
    expect(cf.netChange).toBe(500_000);
    expect(cf.beginningCash + cf.netChange).toBe(cf.endingCash);
    expect(cf.endingCash).toBe(10_500_000);
  });

  it("operatingWorkingCapital lists exactly Piutang/Persediaan/Utang Usaha with correct sign", () => {
    const byCode = (code: string) => cf.operatingWorkingCapital.find((l) => l.code === code);
    expect(byCode("1300")?.contribution).toBe(-4_000_000);
    expect(byCode("1400")?.contribution).toBe(-1_000_000);
    expect(byCode("2100")?.contribution).toBe(1_000_000);
    // Aset Tetap (1610) dan kontra-nya (1630) TIDAK ikut di sini — 1610 sudah
    // kehitung di Investing, 1630 sudah kehitung via depreciationAddBack.
    expect(byCode("1610")).toBeUndefined();
    expect(byCode("1630")).toBeUndefined();
  });
});

describe("computeCashFlow — akun neraca baru otomatis ke-track (regresi bug mismatch Cash Flow)", () => {
  // Akun neraca baru yang lahir belakangan (mis. Piutang Retur Supplier dari fitur
  // retur AP) — dulu gak ada di daftar hardcode AR/Inventory/AP, jadi mutasinya
  // "hilang" dari Operating walau Kas-nya beneran bergerak. Reproduksi persis
  // temuan nyata di data live (2026-08-12): retur bill lunas -> excess reklasifikasi
  // jadi Piutang Retur Supplier, Kas kekurangan tanpa penyeimbang di laporan lama.
  const piutangRetur = account({ code: "1350", category: "asset", normal_balance: "debit" });
  const accountsWithNewLine = [...accounts, piutangRetur];

  const newLines: FixtureLine[] = [
    ...periodLines,
    // Retur bill yang udah lunas -> excess dikreditkan dari Kas ke Piutang Retur Supplier.
    { journal_entry_id: "e8", account_id: piutangRetur.id, debit: 300_000, credit: 0, entry_date: "2026-07-28" },
    { journal_entry_id: "e8", account_id: kas.id, debit: 0, credit: 300_000, entry_date: "2026-07-28" },
  ];
  function linesUpToNew(date: string) {
    return [...openingLines, ...newLines].filter((l) => l.entry_date <= date);
  }
  function linesBetweenNew(start: string, end: string) {
    return [...openingLines, ...newLines].filter((l) => l.entry_date >= start && l.entry_date <= end);
  }

  const tbStart = computeTrialBalance(accountsWithNewLine, linesUpToNew("2026-06-30"), "2026-06-30");
  const tbEnd = computeTrialBalance(accountsWithNewLine, linesUpToNew("2026-07-31"), "2026-07-31");
  const cf = computeCashFlow(
    accountsWithNewLine,
    linesBetweenNew("2026-07-01", "2026-07-31"),
    linesBetweenNew("2026-07-01", "2026-07-31"),
    tbStart,
    tbEnd,
    "2026-07-01",
    "2026-07-31"
  );

  it("Piutang Retur Supplier ikut ke-track di operatingWorkingCapital tanpa perlu hardcode", () => {
    const line = cf.operatingWorkingCapital.find((l) => l.code === "1350");
    expect(line?.delta).toBe(300_000);
    expect(line?.contribution).toBe(-300_000);
  });

  it("tetap reconciled walau ada akun neraca baru yang gak pernah di-hardcode", () => {
    expect(cf.beginningCash + cf.netChange).toBe(cf.endingCash);
    expect(cf.endingCash).toBe(10_200_000); // 10.500.000 dari fixture asal, dikurangi 300.000
    expect(cf.operating).toBe(200_000); // 500.000 dari fixture asal, dikurangi kontribusi -300.000
  });
});

describe("rollupAccountBalances (memory/scope-debt/trial-balance-rollup.md)", () => {
  const balances = computeAccountBalances(accounts, linesUpTo("2026-07-31"));
  const rolled = rollupAccountBalances(accounts, balances);
  const byCode = (code: string) => rolled.find((b) => b.code === code)?.balance;

  it("sums leaf children up to their header account", () => {
    // 1000 Kas = 1100 Kas (10.500.000), header sendiri gak pernah diposting langsung.
    expect(byCode("1000")).toBe(10_500_000);
  });

  it("subtracts contra children from a header, not adds them", () => {
    // 1600 Aset Tetap = 1610 Aset Tetap (15.000.000) - 1630 Akumulasi Penyusutan (250.000, kontra).
    expect(byCode("1600")).toBe(14_750_000);
  });

  it("leaves leaf balances untouched", () => {
    expect(byCode("1300")).toBe(4_000_000);
  });

  it("drops accounts with 0 rollup (no header without active descendants)", () => {
    const noActivityHeader: Account = account({
      code: "9000",
      category: "asset",
      normal_balance: "debit",
    });
    const noActivityLeaf: Account = account({
      code: "9100",
      category: "asset",
      normal_balance: "debit",
      parent_id: "9000",
    });
    const withEmpty = rollupAccountBalances([...accounts, noActivityHeader, noActivityLeaf], balances);
    expect(withEmpty.some((b) => b.code === "9000")).toBe(false);
  });
});

describe("sumBalances", () => {
  it("nets contra accounts against their category instead of adding them", () => {
    const balances = computeAccountBalances(accounts, linesUpTo("2026-07-31")).filter(
      (b) => b.category === "asset"
    );
    const naiveSum = balances.reduce((sum, b) => sum + b.balance, 0);
    // Akumulasi Penyusutan (250.000) harus dikurangkan, bukan ditambah — bedanya 2x nilainya.
    expect(sumBalances(balances)).toBe(naiveSum - 2 * 250_000);
  });
});
