// Tipe barang masuk (goods_notes INBOUND) untuk daftar & detail. Sumber: view goods_receipts_overview
// (migration 0059; status turunan aktif/dibatalkan) + goods_note_lines (nilai baris dihitung sama dengan yang dijurnal).
// Barang masuk SELALU dibuat dari tepat satu tagihan barang (lihat docs/domain/inventory.md "Barang Masuk dari Tagihan").

export type GoodsReceiptStatus = "aktif" | "dibatalkan";

export type GoodsReceiptLine = {
  id: string;
  goods_note_id: string;
  item_id: string;
  qty: number;
  /** Harga per satuan dasar (sebelum diskon baris). */
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
  /** Tagihan induk. Kosong hanya untuk riwayat alur lama yang sudah dibatalkan. */
  bill_id: string | null;
  bill_ref: string | null;
  bill_amount: number | null;
  /** Barang masuk lama (dibuat bareng tagihannya): jurnal Persediaan ada di jurnal tagihan, dibatalkan lewat tagihan. */
  is_legacy: boolean;
  status: GoodsReceiptStatus;
  total_value: number;
  created_at: string;
  created_by: string | null;
  goods_note_lines: GoodsReceiptLine[];
};

/** Nomor yang ditampilkan: nomor barang masuk, atau (alur lama) nomor tagihan bawaannya. */
export function receiptNumber(grn: Pick<GoodsReceiptNote, "source_ref" | "bill_ref">): string {
  return grn.source_ref ?? grn.bill_ref ?? "-";
}
