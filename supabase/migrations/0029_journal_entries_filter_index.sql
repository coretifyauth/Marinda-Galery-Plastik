-- Index buat sort/filter by entry_date di halaman Journal Entries (pagination + date-range
-- filter, lihat memory/architecture/app/tech-stack-decisions.md "Data-fetching ERP (pilot)").
-- journal_entries sebelumnya gak punya index sama sekali.

create index journal_entries_entry_date_idx on journal_entries(entry_date desc);
