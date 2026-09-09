import { z } from "zod";

// Selisih dihitung server-side (qty_actual - qty_system yang berlaku SAAT RPC dipanggil) --
// UI cuma kirim qty_actual, bukan variance yang udah dihitung, biar gak ada celah race
// condition antara UI baca vs RPC eksekusi (ref docs/domain/inventory.md submodule
// "Stock Opname").
export const stockOpnameLineSchema = z.object({
  item_id: z.string().uuid("Pilih item"),
  qty_actual: z.coerce.number().min(0, "Qty hasil hitung gak boleh negatif"),
  inventory_account_id: z.string().uuid("Item ini belum punya akun Persediaan"),
});

export const recordStockOpnameSchema = z.object({
  opname_date: z.string().min(1, "Tanggal wajib diisi"),
  shortage_expense_account_id: z.string().uuid("Pilih akun Beban Selisih Persediaan"),
  surplus_revenue_account_id: z.string().uuid("Pilih akun Pendapatan Selisih Persediaan"),
  lines: z.array(stockOpnameLineSchema).min(1, "Isi minimal 1 baris item"),
});

export type RecordStockOpnameInput = z.infer<typeof recordStockOpnameSchema>;

export type StockOpname = {
  id: string;
  opname_date: string;
  source_ref: string;
  created_at: string;
  stock_opname_lines: {
    id: string;
    item_id: string;
    qty_system: number;
    qty_actual: number;
    unit_cost: number;
    journal_entry_id: string;
    items: { name: string; uom: string };
  }[];
};
