-- document_signatories sengaja dibedain dari pola item_categories/ar_invoice_charge_types
-- (yang delete-nya sengaja ditutup, archived_at doang) -- di sini hard delete AMAN karena
-- gak ada FK dari tabel manapun ke document_signatories.id (cross-cutting config, dibaca
-- by-value pas cetak, bukan direferensi). Keputusan eksplisit user (2026-08-15): admin
-- boleh hapus permanen, archived_at (dari 0026) tetap ada buat nonaktifkan sementara
-- tanpa hapus datanya.

create policy document_signatories_delete on document_signatories
  for delete using (
    exists (select 1 from user_roles ur
            where ur.user_id = auth.uid() and ur.role_name = 'admin')
  );

grant delete on document_signatories to authenticated;
