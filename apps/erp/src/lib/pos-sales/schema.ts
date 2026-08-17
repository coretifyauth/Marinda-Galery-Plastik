export type PosSale = {
  id: string;
  sale_date: string;
  source_ref: string;
  revenue_journal_entry_id: string;
  customers: { name: string } | null;
  cash_account: { code: string; name: string } | null;
  pos_sale_lines: { line_amount: number }[];
};

export type PosSaleStatus = "normal" | "dibatalkan";

export type PosSaleListRow = {
  id: string;
  customer_id: string | null;
  sale_date: string;
  cash_account_id: string;
  revenue_journal_entry_id: string;
  source_ref: string;
  created_at: string;
  total: number;
  status: PosSaleStatus;
  customers: { name: string } | null;
  cash_account: { code: string; name: string } | null;
};
