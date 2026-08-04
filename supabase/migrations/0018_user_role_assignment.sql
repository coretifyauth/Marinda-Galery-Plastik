-- Policy admin buat assign/revoke role user lain lewat aplikasi.
-- user_roles sengaja gak punya RLS policy insert/update biasa: cek "apakah pemanggil admin"
-- lewat subquery ke user_roles sendiri itu circular-check. Solusinya security definer
-- function -- jalan pakai privilege pemilik function (nembus RLS), tapi cek admin
-- dilakuin manual di badan function, bukan diserahin ke RLS.
-- Ref: memory/scope-debt/user-role-admin-assignment.md

create function assign_user_role(
  p_target_user_id uuid,
  p_role_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from user_roles
    where user_id = auth.uid() and role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh assign role';
  end if;

  if not exists (select 1 from roles where name = p_role_name) then
    raise exception 'Role % gak dikenal', p_role_name;
  end if;

  insert into user_roles (user_id, role_name)
  values (p_target_user_id, p_role_name)
  on conflict (user_id, role_name) do nothing;
end;
$$;

create function revoke_user_role(
  p_target_user_id uuid,
  p_role_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from user_roles
    where user_id = auth.uid() and role_name = 'admin'
  ) then
    raise exception 'Cuma admin yang boleh revoke role';
  end if;

  delete from user_roles
  where user_id = p_target_user_id and role_name = p_role_name;
end;
$$;

grant execute on function assign_user_role(uuid, text) to authenticated;
grant execute on function revoke_user_role(uuid, text) to authenticated;
