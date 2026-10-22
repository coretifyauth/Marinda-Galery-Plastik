// Tipe barang masuk (goods_notes INBOUND) untuk daftar & detail. Sumber: view goods_notes_with_billing_status
// (status tagihan turunan) + goods_note_line_current_cost (harga/diskon berlaku setelah revisi).

export type GoodsReceiptStatus = "belum_tertagih" | "tertagih" | "dibatalkan";

export type GoodsReceiptLine = {
  id: string;
  goods_note_id: string;
  item_id: string;
  qty: number;
  /** Harga per satuan dasar yang BERLAKU (revisi terakhir, atau nilai asli kalau belum pernah direvisi). */
  unit_cost: number;
  discount_amount: number;
  /** qty x unit_cost - discount_amount, dibulatkan 2 desimal (sama dengan yang dijurnal). */
  line_value: number;
  items: { name: string; uom: string; item_units: { unit_label: string; conversion_factor: number }[] };
};

export type GoodsReceiptNote = {
  id: string;
  counterparty_id: string | null;
  supplier_name: string | null;
  note_date: string;
  /** Nomor barang masuk (GRN-...). Kosong untuk barang masuk lama yang dibuat bareng tagihannya. */
  source_ref: string | null;
  delivery_note_ref: string | null;
  order_id: string | null;
  order_ref: string | null;
  /** bundled = alur lama (dibuat bareng tagihan), deferred = alur baru (tagihan menyusul). */
  inbound_flow: "bundled" | "deferred";
  created_at: string;
  created_by: string | null;
  billing_status: GoodsReceiptStatus;
  bill_id: string | null;
  bill_ref: string | null;
  bill_amount: number | null;
  total_value: number;
  revision_no: number;
  unbilled_age_days: number | null;
  goods_note_lines: GoodsReceiptLine[];
};

/** Nomor yang ditampilkan: nomor barang masuk, atau (alur lama) nomor tagihan bawaannya. */
export function receiptNumber(grn: Pick<GoodsReceiptNote, "source_ref" | "bill_ref">): string {
  return grn.source_ref ?? grn.bill_ref ?? "-";
}

export function hasZeroValueLine(grn: Pick<GoodsReceiptNote, "goods_note_lines">): boolean {
  return grn.goods_note_lines.some((l) => l.line_value <= 0);
}
