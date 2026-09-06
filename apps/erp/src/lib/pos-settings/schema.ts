import { supabase } from "@/lib/supabase/client";

// pos_settings (migration 0076) -- singleton, nyimpen id counterparty "Pelanggan Umum"
// (walk-in) yang dipakai create_pos_sale kalau kasir gak pilih customer. Dipakai form
// AR (AR Invoice/Deposit, Goods Issue, Sales Order) buat nge-exclude row ini dari
// dropdown pilih customer -- walk-in cuma boleh muncul lewat jalur create_pos_sale,
// bukan dipilih manual buat kredit/DP/SO sungguhan (lihat memory/scope-debt/pos-unify-transactions.md).
export async function fetchWalkInCustomerId(): Promise<string | null> {
  const { data } = await supabase.from("pos_settings").select("walk_in_customer_id").maybeSingle();
  return (data as { walk_in_customer_id: string } | null)?.walk_in_customer_id ?? null;
}
