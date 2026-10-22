import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";

// Kolam tagihan barang (view ap_bill_goods_pool_status, migration 0057): nilai bagian barang tagihan yang menunggu
// barang masuk. sisa = pool - nilai barang masuk aktif - pelepasan. Lihat docs/domain/accounts-payable.md
// submodule "Tagihan Dulu, Barang Menyusul (Kolam Tagihan)".
export type ApBillPool = {
  bill_id: string;
  counterparty_id: string;
  supplier_name: string | null;
  bill_ref: string;
  bill_date: string;
  bill_status: string;
  pool_amount: number;
  received_value: number;
  released_amount: number;
  remaining: number;
  /** Umur (hari) kolam yang masih terbuka; null kalau kolam sudah habis atau tagihan dibatalkan. */
  open_age_days: number | null;
};

export type ApBillPoolRelease = {
  id: string;
  kind: "pembulatan" | "uang_muka";
  amount: number;
  release_date: string;
  source_ref: string;
  deposit_id: string | null;
};

const POOL_COLUMNS =
  "bill_id, counterparty_id, supplier_name, bill_ref, bill_date, bill_status, pool_amount, received_value, released_amount, remaining, open_age_days";

export async function fetchPool(billId: string): Promise<ApBillPool | null> {
  const { data, error } = await supabase
    .from("ap_bill_goods_pool_status")
    .select(POOL_COLUMNS)
    .eq("bill_id", billId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as ApBillPool | null) ?? null;
}

export async function fetchPoolReleases(billId: string): Promise<ApBillPoolRelease[]> {
  const { data, error } = await supabase
    .from("bill_pool_releases")
    .select("id, kind, amount, release_date, source_ref, deposit_id")
    .eq("transaction_id", billId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ApBillPoolRelease[];
}

// Tagihan barang yang kolamnya masih punya sisa (belum dibatalkan) -- pilihan form barang masuk. Tertua dulu.
export async function fetchOpenPoolBills(supplierId?: string): Promise<ApBillPool[]> {
  let query = supabase
    .from("ap_bill_goods_pool_status")
    .select(POOL_COLUMNS)
    .neq("bill_status", "dibatalkan")
    .gt("remaining", 0)
    .order("bill_date", { ascending: true });
  if (supplierId) query = query.eq("counterparty_id", supplierId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ApBillPool[];
}

export function usePool(billId: string) {
  return useQuery({
    queryKey: ["ap_bill_pool", billId],
    queryFn: () => fetchPool(billId),
    enabled: !!billId,
    staleTime: 5_000,
  });
}

export function usePoolReleases(billId: string) {
  return useQuery({
    queryKey: ["ap_bill_pool_releases", billId],
    queryFn: () => fetchPoolReleases(billId),
    enabled: !!billId,
    staleTime: 5_000,
  });
}

export function useOpenPoolBills(supplierId?: string, enabled = true) {
  return useQuery({
    queryKey: ["open_pool_bills", supplierId ?? ""],
    queryFn: () => fetchOpenPoolBills(supplierId),
    enabled,
    staleTime: 5_000,
  });
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Batas uang muka dari sisa kolam, mirror release_ap_bill_pool: hanya bagian barang yang SUDAH DIBAYAR dan belum
 * terpakai. Biaya tambahan + PPN (bill - pool) dianggap dibayar lebih dulu. Dipakai untuk pratinjau; angka final
 * dihitung ulang server-side.
 */
export function poolDepositLimit(input: {
  billAmount: number;
  pool: Pick<ApBillPool, "pool_amount" | "received_value" | "remaining">;
  paid: number;
  releasedAsDeposit: number;
}): number {
  const { billAmount, pool, paid, releasedAsDeposit } = input;
  const extras = billAmount - pool.pool_amount;
  const limit = Math.max(0, paid - extras - pool.received_value - releasedAsDeposit);
  return round2(Math.min(limit, pool.remaining));
}
