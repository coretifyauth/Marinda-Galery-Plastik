-- Fix: transaction trigger yang terlalu ketat, nge-blok recompute_transaction_status.
-- recompute_transaction_status (security definer) perlu UPDATE kolom turunan
-- (outstanding, returned, status, origin) di tabel transactions tiap ada goods receipt,
-- payment, retur, deposit, atau return_credit baru — tapi trigger lama pakai
-- block_edit_delete() yang blok SEMUA update/delete, jadi error
-- "journal_entries/journal_lines gak pernah bisa diedit/dihapus".
-- Ikuti pola orders (orders_block_edit_delete_or_cancel) & deposits
-- (deposits_block_edit_delete_or_sync): bolehkan UPDATE cuma kolom turunan,
-- tetap blok DELETE dan perubahan ke kolom bisnis inti.

create or replace function transactions_block_edit_delete_or_sync() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'transactions gak pernah bisa dihapus -- cuma reversing entry (lihat general-ledger.md)';
  end if;

  if (old.type, old.counterparty_id, old.date, old.due_date, old.description, old.source_ref,
      old.amount, old.supplier_document_ref, old.journal_entry_id, old.created_by, old.created_at)
     is distinct from
     (new.type, new.counterparty_id, new.date, new.due_date, new.description, new.source_ref,
      new.amount, new.supplier_document_ref, new.journal_entry_id, new.created_by, new.created_at) then
    raise exception 'transactions gak pernah bisa diedit/dihapus -- cuma reversing entry (lihat general-ledger.md)';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists transactions_block_edit_delete on transactions;

create trigger transactions_block_edit_delete
  before update or delete on transactions
  for each row execute function transactions_block_edit_delete_or_sync();
