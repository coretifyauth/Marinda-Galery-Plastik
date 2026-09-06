export type PosSale = {
  id: string;
  sale_date: string;
  source_ref: string;
  revenue_journal_entry_id: string;
  counterparties: { name: string } | null;
  cash_account: { code: string; name: string } | null;
  pos_sale_lines: { line_amount: number }[];
};

export type PosSaleStatus = "normal" | "dibatalkan";

// pos_sales_with_status (migration 0076) -- UNION pos_sales_legacy (pra-cutover) +
// pos_sales baru (join transactions/payments). Kolom FLAT (customer_name/
// cash_account_code/cash_account_name), BUKAN relasi PostgREST embed -- view UNION
// gak reliable buat auto-embed FK, lihat komentar di migration.
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
