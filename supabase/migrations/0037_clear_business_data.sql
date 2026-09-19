-- Data cleanup: hapus semua data bisnis, pertahankan data user.
-- Dipush dengan engine migra (pg-delta disabled sementara) — TRUNCATE adalah operasi
-- data, pg-delta (schema diff engine) akan meng-skip-nya.
--
-- Tabel yang DITUTUP (user data): app_roles, app_user_roles, app_user_signup_whitelist
-- + seluruh schema auth (auth.users, auth.refresh_tokens, dst).
-- TRUNCATE CASCADE handle FK dependency otomatis; urutan tidak perlu dipilih belajar.
-- Semua trigger block_edit_delete hanya BEFORE UPDATE/OR DELETE — TRUNCATE tidak memicu-nya.

truncate table
  goods_note_lines,
  inventory_movements,
  stock_opname_lines,
  production_order_lines,
  replacement_lines,
  return_lines,
  deposit_applications,
  deposit_refunds,
  deposit_forfeitures,
  bom_lines,
  order_lines,
  transaction_lines,
  journal_lines,
  app_preset_journal_entry_lines,
  app_default_account_settings,
  item_units,
  counterparty_type_mapping,
  document_number_counters
restart identity cascade;

truncate table
  goods_notes,
  inventory_balances,
  stock_opnames,
  production_orders,
  replacements,
  returns,
  deposits,
  bom_headers,
  orders,
  transactions,
  app_preset_journal_entries,
  items,
  item_categories,
  item_brands,
  counterparties,
  document_number_types,
  charge_categories,
  payments,
  app_settings,
  period_closings,
  journal_entries,
  accounts
restart identity cascade;
