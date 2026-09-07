export type PosSaleStatus = "normal" | "dibatalkan";

// pos_sales_with_status (migration 0078) -- single-source, PURE STRUKTURAL (transactions
// join goods_issues+payments, exactly-1-of-each + no retur/DP -- gak ada tabel penanda
// pos_sales lagi). Kolom FLAT (customer_name/cash_account_code/cash_account_name) --
// cash_account_* dibaca dari baris debit jurnal payment, bukan kolom disalin.
export type PosSaleListRow = {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  sale_date: string;
  cash_account_id: string;
  cash_account_code: string | null;
  cash_account_name: string | null;
  revenue_journal_entry_id: string;
  source_ref: string;
  total: number;
  status: PosSaleStatus;
};
