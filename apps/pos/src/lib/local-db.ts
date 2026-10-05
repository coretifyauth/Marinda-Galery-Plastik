/** Cache lokal + antrian transaksi offline, disimpan di IndexedDB lewat Dexie.
 * Sengaja BUKAN SQLite -- jalan murni di WebView2, gak nambah plugin Rust/native.
 * Lihat plan: offline sync untuk POS (IndexedDB + outbox pattern). */
import Dexie, { type Table } from "dexie";
import type { ChargeType, Customer, ItemRow, SaleHistoryItem, TaxSettings } from "./pos-types";

export type KeyValueRow<T = unknown> = { key: string; value: T; updatedAt: string };

export type OutboxStatus = "pending" | "syncing" | "failed_stock" | "failed_other";

// Persis parameter RPC create_pos_sale, MINUS p_source_ref -- itu baru di-generate
// pas sync (butuh online, lihat document-numbers.ts).
export type OutboxSalePayload = {
  p_sale_date: string;
  p_customer_id: string | null;
  p_cash_account_id: string;
  p_revenue_account_id: string;
  p_hpp_account_id: string;
  p_finished_good_account_id: string;
  p_extra_credit_lines: { account_id: string; amount: number }[];
  p_apply_tax: boolean;
  /** Diskon manual kasir (Rp, per transaksi). Opsional: row outbox lama (sebelum fitur ini) gak punya, server default 0. */
  p_manual_discount?: number;
  p_lines: { item_id: string; qty_sold: number; unit_price: number }[];
};

// Data siap-pakai buat nyusun SaleHistoryItem (riwayat) & ReceiptData (struk) tanpa
// perlu round-trip lagi -- persis SaleHistoryItem dikurangi field yang udah ada di
// level OutboxSale sendiri (id/sourceRef/createdAt).
export type OutboxReceiptSnapshot = Omit<SaleHistoryItem, "id" | "sourceRef" | "createdAt">;

export type OutboxSale = {
  id: string; // crypto.randomUUID(), idempotency key lokal
  tempSourceRef: string; // "OFFLINE-{deviceId}-{seq}"
  status: OutboxStatus;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
  lastError: string | null;
  payload: OutboxSalePayload;
  receiptSnapshot: OutboxReceiptSnapshot;
};

export type ReconciliationLogRow = {
  id?: number; // autoIncrement
  tempRef: string;
  realRef: string;
  syncedAt: string;
};

class PosLocalDb extends Dexie {
  items!: Table<ItemRow, string>;
  customers!: Table<Customer, string>;
  chargeTypes!: Table<ChargeType, string>;
  keyValue!: Table<KeyValueRow, string>;
  outboxSales!: Table<OutboxSale, string>;
  reconciliationLog!: Table<ReconciliationLogRow, number>;

  constructor() {
    super("pos-local-db");
    this.version(1).stores({
      items: "id, name",
      customers: "id, name",
      chargeTypes: "id",
      keyValue: "key",
      outboxSales: "id, status, createdAt",
      reconciliationLog: "++id, tempRef, syncedAt",
    });
  }
}

export const localDb = new PosLocalDb();

// Helper buat 3 query "singleton" (accounts map, tax_settings, company_settings)
// yang disatuin ke 1 tabel keyValue, biar gak bikin tabel terpisah cuma buat blob
// tunggal.
export async function getKeyValue<T>(key: string): Promise<T | undefined> {
  const row = await localDb.keyValue.get(key);
  return row?.value as T | undefined;
}

export async function setKeyValue<T>(key: string, value: T): Promise<void> {
  await localDb.keyValue.put({ key, value, updatedAt: new Date().toISOString() });
}

export type { ItemRow, Customer, ChargeType, TaxSettings };
