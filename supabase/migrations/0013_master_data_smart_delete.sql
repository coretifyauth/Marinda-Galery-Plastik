-- Smart delete buat master data (Items, Customers, Suppliers, Accounts): kalau record belum
-- pernah dipakai di transaksi apa pun, hapus permanen; kalau sudah pernah dipakai, arsipkan
-- (archived_at) seperti biasa -- bukan ditolak. Keputusan diambil lewat diskusi dengan user
-- (2026-08-12), merevisi kebijakan lama yang sengaja MENUTUP TOTAL hard delete di RLS (lihat
-- komentar "sengaja gak ada policy DELETE" di 0001_coa_schema.sql/0004_inventory_schema.sql/
-- 0005_ar_schema.sql/0006_ap_schema.sql -- kebijakan itu sekarang direvisi, bukan dihapus diam-
-- diam, lihat memory/preferences/system/state-naming-convention.md).
--
-- Mekanisme: coba DELETE baris aslinya dulu. Semua kolom item_id/customer_id/supplier_id/
-- account_id di tabel lain di project ini adalah FK sungguhan TANPA "on delete cascade"
-- (diverifikasi lewat audit seluruh migration) -- jadi Postgres sendiri yang otomatis nolak
-- (foreign_key_violation, SQLSTATE 23503) begitu ADA baris lain yang masih nunjuk ke situ, di
-- MANA PUN tabel itu berada, termasuk modul yang belum ada sekarang tapi ditambah nanti. Gak
-- perlu enumerasi manual tabel referensi satu-satu (rawan kelewat & gampang basi) -- integritas
-- referensial DB sendiri jadi satu-satunya sumber kebenaran soal "pernah dipakai atau belum".
-- Exception itu ditangkap, fallback ke UPDATE archived_at (arsipkan), bukan gagal total.
--
-- Khusus items: item_units (satuan jual/harga) dianggap KONFIGURASI item itu sendiri, BUKAN
-- riwayat transaksi eksternal -- makanya dihapus duluan bareng item-nya (gak dianggap "sudah
-- dipakai"), baru sisanya (baris di tabel transaksional lain: PO/GRN/SO/GI/BOM/production/
-- opname/POS lines, inventory_balances) yang beneran menahan hard delete lewat FK violation.
--
-- security definer wajib -- gak ada grant/policy DELETE ke authenticated di tabel manapun
-- (tetap gitu, sengaja), jadi fungsi ini yang jalan pakai privilege pemilik fungsi. Cek role
-- admin/accountant dilakukan manual di dalam body (security definer bypass RLS), mirror syarat
-- policy _update yang sudah ada di tiap tabel.

create function delete_item(p_item_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant')
  ) then
    raise exception 'Cuma admin/accountant yang boleh menghapus item';
  end if;

  begin
    -- item_units WAJIB dihapus di DALAM blok yang sama dengan delete items -- begin/exception
    -- di PL/pgSQL cuma bikin savepoint di titik "begin", jadi statement SEBELUM blok ini gak
    -- ikut rollback kalau exception ketangkep. Kalau item_units dihapus di LUAR sini dan delete
    -- items gagal (fallback ke arsip), konfigurasi satuan jual/harga item itu hilang permanen
    -- padahal item-nya sendiri masih hidup (diarsipkan, BUKAN dihapus) -- kontradiksi sifat
    -- reversible archived_at (state-naming-convention.md) dan bikin UI "Aktifkan" existing
    -- (items/[id]/view.tsx) mengembalikan item tanpa satuan jualnya lagi, tanpa error apa pun.
    delete from item_units where item_id = p_item_id;
    delete from items where id = p_item_id;
    return 'deleted';
  exception when foreign_key_violation then
    update items set archived_at = now(), updated_at = now() where id = p_item_id;
    return 'archived';
  end;
end;
$$;

create function delete_customer(p_customer_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant')
  ) then
    raise exception 'Cuma admin/accountant yang boleh menghapus customer';
  end if;

  begin
    delete from customers where id = p_customer_id;
    return 'deleted';
  exception when foreign_key_violation then
    update customers set archived_at = now() where id = p_customer_id;
    return 'archived';
  end;
end;
$$;

create function delete_supplier(p_supplier_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant')
  ) then
    raise exception 'Cuma admin/accountant yang boleh menghapus supplier';
  end if;

  begin
    delete from suppliers where id = p_supplier_id;
    return 'deleted';
  exception when foreign_key_violation then
    update suppliers set archived_at = now() where id = p_supplier_id;
    return 'archived';
  end;
end;
$$;

-- Akun: exception yang sama juga otomatis nutup 2 kasus lain tanpa kode tambahan --
-- akun yang udah dipakai journal_lines (FK journal_lines.account_id) ATAU akun header yang
-- masih punya child (FK self-referencing accounts.parent_id) sama-sama bikin DELETE gagal
-- lewat foreign_key_violation, jatuh ke arsipkan -- gak boleh hard delete di kedua kasus itu.
create function delete_account(p_account_id uuid) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid() and ur.role_name in ('admin','accountant')
  ) then
    raise exception 'Cuma admin/accountant yang boleh menghapus akun';
  end if;

  begin
    delete from accounts where id = p_account_id;
    return 'deleted';
  exception when foreign_key_violation then
    update accounts set archived_at = now() where id = p_account_id;
    return 'archived';
  end;
end;
$$;

grant execute on function delete_item(uuid) to authenticated;
grant execute on function delete_customer(uuid) to authenticated;
grant execute on function delete_supplier(uuid) to authenticated;
grant execute on function delete_account(uuid) to authenticated;
