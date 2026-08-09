import { z } from "zod";

export const purchaseReturnLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty_returned: z.coerce.number().positive("Qty retur harus lebih dari 0"),
});

/**
 * Opsi A (Kurangi Utang) — mirror createArCreditNoteSchema di ar-credit-notes/schema.ts.
 * `lines` kosong = jalur financial-only (p_amount dipakai apa adanya). `lines` terisi =
 * jalur full (bill wajib punya goods_receipt_notes) — `amount` di sini cuma placeholder
 * client-side, RPC create_ap_credit_note DIABAIKAN dan diganti hasil consume_weighted_average
 * server-side (ref 0035 komentar RPC). `return_credit_asset_account_id` optional di schema,
 * tapi wajib diisi kalau retur bikin Utang Usaha jadi minus (server yang nolak kalau kosong).
 */
export const createApCreditNoteSchema = z.object({
  bill_id: z.string().uuid("Pilih bill"),
  credit_note_date: z.string().min(1, "Tanggal wajib diisi"),
  source_ref: z.string().min(1, "Rujukan dokumen wajib diisi"),
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
  goods_receipt_lines: {
    item_id: string;
    qty_received: number;
    unit_cost: number;
    items: { name: string; uom: string };
  }[];
};
