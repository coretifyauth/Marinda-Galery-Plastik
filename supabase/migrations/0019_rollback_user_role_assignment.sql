-- Rollback migration 0018_user_role_assignment.sql.
-- Gak edit/hapus 0018 (udah kepush ke remote) -- migration baru yang reverse.

drop function if exists assign_user_role(uuid, text);
drop function if exists revoke_user_role(uuid, text);
