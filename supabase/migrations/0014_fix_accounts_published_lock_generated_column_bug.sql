-- Bugfix: accounts_published_lock_trigger (0003_journal_entry_schema.sql) membandingkan
-- old.normal_balance vs new.normal_balance lewat row-value "IS DISTINCT FROM". normal_balance
-- adalah GENERATED ALWAYS AS ... STORED column (turunan dari category+is_contra) -- dan Postgres
-- BELUM menghitung ulang stored generated column di titik BEFORE trigger jalan (baru dihitung
-- SETELAH semua BEFORE trigger selesai). Akibatnya NEW.normal_balance di dalam trigger ini SELALU
-- NULL, bukan nilai barunya -- dibuktikan lewat probe langsung ke database live (2026-08-12):
-- "old=debit new=<NULL>" pas update kolom LAIN (archived_at) yang gak ada hubungannya sama
-- normal_balance sama sekali. NULL IS DISTINCT FROM 'debit' = true, jadi kondisi lock ini
-- SELALU true untuk akun yang published, buat UPDATE apa pun -- bukan cuma nyegah perubahan ke 5
-- kolom yang dimaksud (code/category/normal_balance/parent_id/is_contra), tapi nutup total
-- SEMUA update ke akun published, termasuk archived_at/name yang harusnya tetap boleh diubah
-- (didokumentasikan di apps/erp/src/app/(app)/accounts/[id]/view.tsx: "Cuma name/archived_at
-- yang masih bisa diubah" -- klaim itu gak pernah beneran teruji sampai fitur delete_account
-- migration 0013 pertama kali coba update archived_at pada akun published).
--
-- Fix: keluarkan normal_balance dari perbandingan. Ini AMAN -- normal_balance murni fungsi
-- deterministik dari category+is_contra (lihat generation expression-nya), jadi kalau
-- category+is_contra gak berubah, normal_balance juga pasti gak berubah -- gak perlu dicek
-- terpisah, dan mengeceknya terpisah justru yang jadi sumber bug ini.

create or replace function accounts_published_lock() returns trigger as $$
begin
  if (old.code, old.category, old.parent_id, old.is_contra)
     is distinct from (new.code, new.category, new.parent_id, new.is_contra) then
    if exists (select 1 from journal_lines where account_id = old.id) then
      raise exception 'Akun % sudah dipakai di jurnal — code/category/normal_balance/parent_id/is_contra terkunci', old.code;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
