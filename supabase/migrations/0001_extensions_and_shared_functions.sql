-- Extensions & fungsi generic yang dipakai ulang lintas modul.
--
-- CATATAN KONSOLIDASI (2026-09-07): file ini bagian dari rombak total supabase/migrations/
-- dari incremental history (83 file, 0001-0083) jadi final-state-per-spine (mirror
-- memory/architecture/data/*.md). Riwayat evolusi lengkap (kenapa tiap keputusan diambil,
-- bug yang pernah kejadian & diperbaiki) ADA di git log + memory/architecture/data/*.md --
-- file-file baru ini SENGAJA cuma nyimpen bentuk FINAL, bukan histori incremental.

create extension if not exists pgcrypto; -- gen_random_uuid()
create extension if not exists btree_gist; -- exclusion constraint period_closings (financial-reports-schema.md)

-- set_updated_at() -- reuse tiap tabel yang punya kolom updated_at (accounts, items,
-- counterparties, dst). Ref: coa-schema.md.
create function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- block_edit_delete() -- reuse tiap tabel transaksional immutable (journal_entries,
-- transactions, goods_notes, dst). RLS default-deny (gak ada policy UPDATE/DELETE) adalah
-- lapis pertama; trigger ini lapis kedua. Ref: journal-entry-schema.md.
create function block_edit_delete() returns trigger as $$
begin
  raise exception 'journal_entries/journal_lines gak pernah bisa diedit/dihapus -- cuma reversing entry (lihat general-ledger.md)';
end;
$$ language plpgsql;
