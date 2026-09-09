-- Pulihkan check(num_nonnulls(...)=1) di inventory_movements -- constraint ini hilang sejak
-- migration lama 0068 (drop column nyabut constraint gabungan), gagal dipulihkan lagi di
-- migration lama 0075 karena 2 baris live anomali (num_nonnulls=0, "Ember Plastik 10L") tanpa
-- jurnal pasangan -- lihat memory/scope-debt/inventory-movements-exactly-one-source-constraint.md
-- (histori lengkap). Sekarang AMAN dipulihkan: inventory_movements di-TRUNCATE total
-- (2026-09-07, bagian konsolidasi migration folder) -- 0 baris tersisa, gak ada lagi data
-- historis yang bisa melanggar constraint ini. Scope-debt ditutup.

alter table inventory_movements add constraint inventory_movements_exactly_one_source check (
  num_nonnulls(
    goods_note_line_id, production_order_id, return_line_id,
    stock_opname_line_id, production_order_line_id,
    warranty_replacement_line_id, purchase_replacement_line_id
  ) = 1
);
