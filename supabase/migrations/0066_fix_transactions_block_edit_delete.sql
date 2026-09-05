-- BUG FIX KRITIS, ketauan review sebelum apply migration 0067 (unifikasi vocabulary
-- origin) -- `transactions_block_edit_delete` (dipasang migration 0063_transactions_schema.sql)
-- pakai `block_edit_delete()` GENERIK yang nolak SEMUA update tanpa kecuali. Ini berarti
-- SEJAK 0063 LIVE, trigger `recompute_transaction_status` (0064) gagal tiap kali dipanggil
-- -- artinya SETIAP AR payment/AP payment/credit note/goods issue baru/goods receipt baru/
-- deposit application baru/reversal jurnal baru yang direkam lewat aplikasi sejak 0063 live
-- bakal GAGAL dengan error "journal_entries/journal_lines gak pernah bisa diedit/dihapus"
-- (pesan generik `block_edit_delete()`, membingungkan karena nyebut jurnal padahal yang
-- ketolak insert ke transactions).
--
-- Root cause: desain awal (memory/scope-debt/ar-ap-unify-transactions.md langkah 7)
-- eksplisit bilang trigger transactions harus "ngikutin persis" pola `_or_sync` yang udah
-- ada di ar_invoices/ap_bills (migration 0053) -- tapi migration 0063 kelewat, malah pasang
-- block_edit_delete() polos. Baru ketauan sekarang (review migration 0067) karena belum ada
-- transaksi baru yang lewat jalur recompute sejak cutover -- semua baris yang ada sekarang
-- hasil backfill 0064 (INSERT langsung, gak lewat recompute_transaction_status).
--
-- Fix: pola byte-identik ar_invoices_block_edit_delete_or_sync/ap_bills_block_edit_delete_or_sync
-- (0053, sekarang udah didrop bareng tabelnya di 0065) -- kolom bisnis asli TETAP immutable,
-- cuma outstanding/returned/status/origin (kolom sync) yang boleh diubah trigger otomatis.

drop trigger transactions_block_edit_delete on transactions;

create function transactions_block_edit_delete_or_sync() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'transactions gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  if (old.type, old.counterparty_id, old.date, old.due_date, old.description, old.source_ref,
      old.amount, old.supplier_document_ref, old.journal_entry_id, old.created_by, old.created_at)
     is distinct from
     (new.type, new.counterparty_id, new.date, new.due_date, new.description, new.source_ref,
      new.amount, new.supplier_document_ref, new.journal_entry_id, new.created_by, new.created_at) then
    raise exception 'transactions gak pernah bisa diedit/dihapus — cuma reversing entry (lihat general-ledger.md)';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger transactions_block_edit_delete
  before update or delete on transactions
  for each row execute function transactions_block_edit_delete_or_sync();

-- Trigger role-guard (transactions_counterparty_role_guard_inbound/outbound, 0063) TIDAK
-- disentuh -- keduanya udah cuma `before insert`, gak pernah kena masalah yang sama
-- (recompute_transaction_status cuma UPDATE, gak pernah INSERT baris baru).
