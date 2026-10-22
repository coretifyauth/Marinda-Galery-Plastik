import { z } from "zod";

export const grnLineSchema = z.object({
  order_line_id: z.string().uuid("Baris PO gak valid").optional(),
  item_id: z.string().uuid("Item gak valid"),
  qty_received: z.coerce.number().positive("Qty harus lebih dari 0"),
  // Harga 0 boleh (belum tahu) -- barangnya belum bisa dijual/ditagih sampai diberi harga (revisi).
  unit_cost: z.coerce.number().nonnegative("Harga gak boleh negatif"),
  // Diskon item (Rupiah, per baris). Diskon tambahan level dokumen = discount_amount di bawah.
  discount_amount: z.coerce.number().nonnegative("Diskon item gak boleh negatif").default(0),
});

// Barang masuk TANPA tagihan (alur Barang Masuk Belum Ditagih). Tagihan dibuat terpisah dari barang
// masuk yang sudah ada -- lihat lib/ap-bills dan docs/domain/inventory.md.
export const createGoodsReceiptSchema = z
  .object({
    order_id: z.string().uuid("Pilih purchase order").optional(),
    supplier_id: z.string().uuid("Pilih supplier").optional(),
    receipt_date: z.string().min(1, "Tanggal wajib diisi"),
    delivery_note_ref: z.string().optional(),
    inventory_account_id: z.string().uuid("Pilih akun Persediaan"),
    lines: z.array(grnLineSchema).min(1, "Minimal 1 baris item"),
    // Diskon tambahan level dokumen, di atas diskon item; diproratakan server-side ke baris.
    discount_amount: z.coerce.number().nonnegative().default(0),
  })
  // Purchase Order opsional (memory/scope-debt/order-generalization.md Fase 2) -- tapi
  // begitu gak ada PO, supplier-nya harus dipilih manual, gak ada jalur lain buat tau siapa
  // yang ditagih.
  .refine((v) => !!v.order_id || !!v.supplier_id, {
    message: "Pilih Purchase Order, atau pilih supplier kalau terima barang langsung",
    path: ["supplier_id"],
  });

export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;

export type { GoodsReceiptNote, GoodsReceiptLine, GoodsReceiptStatus } from "./types";
