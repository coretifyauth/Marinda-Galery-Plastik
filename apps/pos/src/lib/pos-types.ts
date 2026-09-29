/** Tipe data yang dipakai bareng antara page.tsx dan lapisan cache offline
 * (local-db.ts) -- diekstrak ke sini biar local-db.ts bisa import tanpa
 * circular dependency ke page.tsx. */

export type CartLine = {
  item_id: string;
  name: string;
  unit_label: string;
  conversion_factor: number;
  unit_price: number;
  qty_sold: number;
  available: number;
};

export type Customer = {
  id: string;
  name: string;
  contact: string | null;
};

export type ChargeType = {
  id: string;
  name: string;
  account_id: string;
};

export type TaxSettings = {
  is_active: boolean;
  ppn_rate: number;
};

// Baris mentah dari query "items" -- disimpen di cache React Query APA ADANYA (bukan
// CatalogItem/ScannableUnit yang udah diolah), biar checkout() bisa nge-patch
// `inventory_balances.qty_on_hand` langsung di cache abis sukses (tanpa refetch ulang
// seluruh katalog) -- CatalogItem/ScannableUnit diturunkan dari ini lewat useMemo.
export type ItemRow = {
  id: string;
  name: string;
  uom: string;
  category_id: string | null;
  item_units:
    | { unit_label: string; conversion_factor: number; price: number | null; is_base: boolean; barcode: string | null }[]
    | null;
  inventory_balances: { qty_on_hand: number } | null;
};

// Riwayat singkat buat panel "Transaksi Terakhir" + cetak ulang/kirim WA -- goods_issue_lines
// nyimpen qty/harga dalam SATUAN DASAR selalu (create_pos_sale konversi sebelum insert),
// jadi unit_label transaksi asli (kalau dari scan satuan bukan-dasar) gak tersimpan --
// riwayat nampilin qty x harga dalam satuan dasar item, bukan satuan yang dipilih pas jual.
export type SaleHistoryLine = { name: string; uom: string; qty: number; unitPrice: number; amount: number };
export type SaleHistoryItem = {
  id: string;
  sourceRef: string;
  createdAt: string;
  customerName: string | null;
  customerContact: string | null;
  cashAccountId: string;
  lines: SaleHistoryLine[];
  extraTotal: number;
  taxTotal: number;
  discountTotal: number;
};
