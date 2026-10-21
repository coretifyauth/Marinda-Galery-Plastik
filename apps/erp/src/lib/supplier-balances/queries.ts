import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";

export type SupplierBalanceKind = "uang_muka" | "kelebihan_retur";

export type SupplierBalanceRow = {
  kind: SupplierBalanceKind;
  id: string;
  source_ref: string;
  date: string;
  amount: number;
  remaining: number;
  /** Halaman dokumen sumber (detail uang muka / detail bill asal retur). */
  detailHref: string;
  /** Aksi yang tersedia hari ini buat saldo ini — null kalau cuma bisa dilihat. */
  actionLabel: string | null;
  actionHref: string | null;
};

export type SupplierBalances = {
  rows: SupplierBalanceRow[];
  uangMukaTotal: number;
  kelebihanReturTotal: number;
};

type DepositRow = {
  id: string;
  deposit_date: string;
  source_ref: string;
  amount: number;
  remaining: number;
};

type ReturnCreditRow = {
  id: string;
  amount: number;
  returns: { source_ref: string; credit_note_date: string; transaction_id: string } | null;
  return_credit_refunds: { amount: number }[];
};

const EPSILON = 0.005;

// Saldo yang masih ada di supplier = uang muka yang belum habis dipakai + kelebihan retur
// (Piutang Retur Supplier) yang belum direfund. Murni baca — gak ada tulis ke database.
// ap_deposits_with_status (migration 0036) udah ngitung `remaining` server-side.
export async function fetchSupplierBalances(supplierId: string): Promise<SupplierBalances> {
  const [depRes, rcRes] = await Promise.all([
    supabase
      .from("ap_deposits_with_status")
      .select("id, deposit_date, source_ref, amount, remaining")
      .eq("supplier_id", supplierId)
      .gt("remaining", EPSILON)
      .order("deposit_date", { ascending: false }),
    supabase
      .from("return_credits")
      .select("id, amount, returns(source_ref, credit_note_date, transaction_id), return_credit_refunds(amount)")
      .eq("counterparty_id", supplierId)
      .eq("type", "OUTBOUND"),
  ]);
  if (depRes.error) throw new Error(depRes.error.message);
  if (rcRes.error) throw new Error(rcRes.error.message);

  const depositRows: SupplierBalanceRow[] = ((depRes.data ?? []) as unknown as DepositRow[]).map((d) => ({
    kind: "uang_muka",
    id: d.id,
    source_ref: d.source_ref,
    date: d.deposit_date,
    amount: d.amount,
    remaining: d.remaining,
    detailHref: `/ap-deposits/${d.id}`,
    actionLabel: null,
    actionHref: null,
  }));

  const creditRows: SupplierBalanceRow[] = [];
  for (const rc of (rcRes.data ?? []) as unknown as ReturnCreditRow[]) {
    const remaining = rc.amount - rc.return_credit_refunds.reduce((sum, r) => sum + r.amount, 0);
    if (remaining <= EPSILON || !rc.returns) continue;
    creditRows.push({
      kind: "kelebihan_retur",
      id: rc.id,
      source_ref: rc.returns.source_ref,
      date: rc.returns.credit_note_date,
      amount: rc.amount,
      remaining,
      detailHref: `/ap-bills/${rc.returns.transaction_id}`,
      actionLabel: "Minta Kembali Tunai",
      actionHref: `/ap-bills/${rc.returns.transaction_id}/refund-piutang-retur/${rc.id}`,
    });
  }

  const rows = [...depositRows, ...creditRows];
  return {
    rows,
    uangMukaTotal: depositRows.reduce((sum, r) => sum + r.remaining, 0),
    kelebihanReturTotal: creditRows.reduce((sum, r) => sum + r.remaining, 0),
  };
}

export function useSupplierBalances(supplierId: string) {
  return useQuery({
    queryKey: ["supplier_balances", supplierId],
    queryFn: () => fetchSupplierBalances(supplierId),
    enabled: !!supplierId,
    staleTime: 15_000,
  });
}
