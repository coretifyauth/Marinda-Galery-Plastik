import { z } from "zod";
import type { ResolvedAccount } from "@/lib/default-accounts/schema";

export const purchaseReturnLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty_returned: z.coerce.number().positive("Qty retur harus lebih dari 0"),
});

/**
 * Opsi A (Kurangi Utang) — mirror createArCreditNoteSchema di ar-credit-notes/schema.ts.
 * `lines` kosong = jalur financial-only (p_amount dipakai apa adanya). `lines` terisi =
 * jalur full (bill wajib punya goods_receipt_notes) — `amount` di sini cuma placeholder
 * client-side, RPC create_ap_return (dulu create_ap_credit_note) DIABAIKAN dan diganti hasil
 * consume_weighted_average server-side (ref 0035 komentar RPC). `return_credit_asset_account_id` optional di schema,
 * tapi wajib diisi kalau retur bikin Utang Usaha jadi minus (server yang nolak kalau kosong).
 */
export const createApCreditNoteSchema = z.object({
  bill_id: z.string().uuid("Pilih bill"),
  credit_note_date: z.string().min(1, "Tanggal wajib diisi"),
  amount: z.coerce.number().positive("Jumlah harus lebih dari 0"),
  payable_account_id: z.string().uuid("Pilih akun Utang Usaha"),
  credit_account_id: z.string().uuid("Pilih akun Persediaan/Beban"),
  lines: z.array(purchaseReturnLineSchema).default([]),
  return_credit_asset_account_id: z.string().uuid().optional(),
});

export type CreateApCreditNoteInput = z.infer<typeof createApCreditNoteSchema>;

export type ApCreditNote = {
  id: string;
  bill_id: string;
  credit_note_date: string;
  source_ref: string;
  amount: number;
  created_at: string;
};

export type GoodsReceiptForBill = {
  id: string;
  goods_note_lines: {
    item_id: string;
    qty: number;
    unit_cost: number;
    items: { name: string; uom: string };
  }[];
};

/**
 * Pilihan akun kredit retur, mirror guard create_ap_return (migration 0060).
 * Retur barang fisik: stok turun, jadi akun Persediaan yang harus dikredit. Tagihan barang didebit ke Pembelian Belum Diterima
 * (bukan Persediaan), jadi akun Persediaan default ditambahkan. Retur nominal: akun Persediaan wajib lewat qty fisik, dan
 * Pembelian Belum Diterima gak pernah boleh (sisa barang gak ikut turun; jalurnya Koreksi Tagihan).
 */
export function apReturnCreditOptions(input: {
  hasGoodsReceipt: boolean;
  billDebitAccounts: ResolvedAccount[];
  inventoryAccountIds: Set<string>;
  defaultAccounts: Record<string, ResolvedAccount>;
}): ResolvedAccount[] {
  const { hasGoodsReceipt, billDebitAccounts, inventoryAccountIds, defaultAccounts } = input;
  const pendingId = defaultAccounts["inventory.purchase_not_received"]?.id;
  const allowed = billDebitAccounts.filter((a) => a.id !== pendingId);
  if (!hasGoodsReceipt) return allowed.filter((a) => !inventoryAccountIds.has(a.id));

  const inventory = allowed.filter((a) => inventoryAccountIds.has(a.id));
  const defaultInventory = defaultAccounts["inventory.raw_material"];
  if (defaultInventory && !inventory.some((a) => a.id === defaultInventory.id)) inventory.push(defaultInventory);
  return inventory;
}
