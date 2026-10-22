import { z } from "zod";

export const grnLineSchema = z.object({
  order_line_id: z.string().uuid("Baris PO gak valid").optional(),
  item_id: z.string().uuid("Item gak valid"),
  // Kolom tersimpan: qty numeric(14,3), unit_cost numeric(14,2) -- server menolak presisi lebih (bukan membulatkan
  // diam-diam). UI menormalkan lewat normalizeReceiptLine (calc.ts) sebelum sampai sini.
  qty_received: z.coerce
    .number()
    .positive("Qty harus lebih dari 0")
    .refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6, "Qty maksimal 3 desimal"),
  unit_cost: z.coerce
    .number()
    .positive("Harga harus lebih dari 0 -- barang masuk wajib berharga sesuai nota")
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "Harga maksimal 2 desimal"),
  // Diskon item (Rupiah, per baris). Diskon tambahan level dokumen = discount_amount di bawah.
  discount_amount: z.coerce.number().nonnegative("Diskon item gak boleh negatif").default(0),
});

// Barang masuk SELALU dari tepat satu tagihan barang (kolam). Supplier mengikuti tagihan; Purchase Order opsional
// (kalau ada, supplier PO harus sama dengan supplier tagihan) -- lihat docs/domain/inventory.md.
export const createGoodsReceiptSchema = z.object({
  bill_id: z.string().uuid("Pilih tagihan barang"),
  order_id: z.string().uuid("Pilih purchase order").optional(),
  receipt_date: z.string().min(1, "Tanggal wajib diisi"),
  delivery_note_ref: z.string().optional(),
  inventory_account_id: z.string().uuid("Pilih akun Persediaan"),
  lines: z.array(grnLineSchema).min(1, "Minimal 1 baris item"),
  // Diskon tambahan level dokumen, di atas diskon item; diproratakan server-side ke baris.
  discount_amount: z.coerce.number().nonnegative().default(0),
});

export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;

export type { GoodsReceiptNote, GoodsReceiptLine, GoodsReceiptStatus } from "./types";
