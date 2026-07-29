-- Grant EXECUTE eksplisit buat RPC create_journal_entry/reverse_journal_entry.
-- Sama alasan kayak migration 0002: "Automatically expose new tables" dimatikan,
-- lebih aman eksplisit daripada asumsi default grant PostgreSQL ke PUBLIC tetap ada.

grant execute on function create_journal_entry(date, text, text, jsonb) to authenticated;
grant execute on function reverse_journal_entry(uuid, date, text) to authenticated;
