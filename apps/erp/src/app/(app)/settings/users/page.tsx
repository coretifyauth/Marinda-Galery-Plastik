"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  ASSIGNABLE_ROLES,
  roleLabel,
  type AppUser,
  type WhitelistEntry,
} from "@/lib/user-management/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LoadingScreen } from "@/components/ui/loading-screen";

function RoleBadges({ roles }: { roles: string[] }) {
  if (roles.length === 0) {
    return <span className="text-xs text-slate-400">Belum ada role</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <span
          key={r}
          className={`rounded-full px-2 py-0.5 text-xs ${
            r === "master" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"
          }`}
        >
          {roleLabel[r] ?? r}
        </span>
      ))}
    </div>
  );
}

function UsersPanel() {
  const toast = useToast();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<string>("");
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("list_app_users");
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setUsers((data ?? []) as AppUser[]);
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit(user: AppUser) {
    setEditingId(user.user_id);
    setEditRole(user.roles.find((r) => r !== "master") ?? "");
  }

  async function handleSave(user: AppUser) {
    if (!editRole) {
      toast.error("Pilih 1 role");
      return;
    }
    setSavingId(user.user_id);
    const { error } = await supabase.rpc("set_user_roles", {
      p_user_id: user.user_id,
      p_roles: [editRole],
    });
    setSavingId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    setEditingId(null);
    toast.success("Role user berhasil diperbarui.");
    await load();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-1 font-semibold text-black">Pengguna Terdaftar</h2>
      <p className="mb-3 text-sm text-slate-500">
        1 akun cuma boleh punya 1 role. Role <code>master</code> gak bisa diubah di sini — cuma bisa
        disetup manual lewat database.
      </p>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium uppercase text-slate-500">
            <th className="py-1.5">Email</th>
            <th className="py-1.5">Role</th>
            <th className="py-1.5">Terdaftar</th>
            <th className="py-1.5" />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.user_id} className="border-b border-slate-100">
              <td className="py-1.5">{u.email}</td>
              <td className="py-1.5">
                {editingId === u.user_id ? (
                  <div className="flex flex-wrap gap-3">
                    {ASSIGNABLE_ROLES.map((role) => (
                      <label key={role} className="flex items-center gap-1.5 text-sm text-slate-700">
                        <input
                          type="radio"
                          name={`edit-role-${u.user_id}`}
                          checked={editRole === role}
                          onChange={() => setEditRole(role)}
                        />
                        {roleLabel[role]}
                      </label>
                    ))}
                  </div>
                ) : (
                  <RoleBadges roles={u.roles} />
                )}
              </td>
              <td className="py-1.5 text-slate-500">{new Date(u.user_created_at).toLocaleDateString("id-ID")}</td>
              <td className="py-1.5 text-right">
                {editingId === u.user_id ? (
                  <div className="flex justify-end gap-1.5">
                    <Button type="button" variant="toolbar" onClick={() => setEditingId(null)}>
                      Batal
                    </Button>
                    <Button
                      type="button"
                      variant="toolbar-primary"
                      disabled={savingId === u.user_id}
                      onClick={() => handleSave(u)}
                    >
                      {savingId === u.user_id ? "..." : "Simpan"}
                    </Button>
                  </div>
                ) : (
                  !u.roles.includes("master") && (
                    <Button type="button" variant="toolbar" onClick={() => startEdit(u)}>
                      Ubah Role
                    </Button>
                  )
                )}
              </td>
            </tr>
          ))}
          {!loading && users.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-center text-slate-400">
                Belum ada user terdaftar.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function WhitelistPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [entries, setEntries] = useState<WhitelistEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("signup_whitelist")
      .select("id, email, created_by, created_at, consumed_at, signup_whitelist_roles(role_name)")
      .order("created_at", { ascending: false });
    if (err) {
      toast.error(err.message);
      return;
    }
    const rows = (data ?? []) as unknown as Array<
      Omit<WhitelistEntry, "roles"> & { signup_whitelist_roles: { role_name: string }[] }
    >;
    setEntries(
      rows.map((r) => ({
        id: r.id,
        email: r.email,
        created_by: r.created_by,
        created_at: r.created_at,
        consumed_at: r.consumed_at,
        roles: r.signup_whitelist_roles.map((x) => x.role_name),
      }))
    );
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setError("Email wajib diisi");
      return;
    }
    if (!role) {
      setError("Pilih 1 role");
      return;
    }
    setSubmitting(true);
    const { error: err } = await supabase.rpc("add_whitelist_entry", {
      p_email: trimmedEmail,
      p_roles: [role],
    });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setEmail("");
    setRole("");
    setShowForm(false);
    toast.success(`Undangan buat ${trimmedEmail} berhasil dibuat.`);
    await load();
  }

  async function handleRemove(entry: WhitelistEntry) {
    const ok = await confirm({
      title: "Hapus Undangan",
      message: `Hapus undangan buat "${entry.email}"?`,
      confirmLabel: "Hapus",
      danger: true,
    });
    if (!ok) return;
    setRemovingId(entry.id);
    const { error: err } = await supabase.rpc("remove_whitelist_entry", { p_whitelist_id: entry.id });
    setRemovingId(null);
    if (err) {
      toast.error(err.message);
      return;
    }
    toast.success("Undangan berhasil dihapus.");
    await load();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold text-black">Whitelist Registrasi</h2>
        <Button variant="toolbar-primary" onClick={() => setShowForm(true)}>
          + Undang
        </Button>
      </div>
      <p className="mb-3 text-sm text-slate-500">
        Cuma email yang terdaftar di sini yang bisa signup lewat <code>/signup</code>. Orangnya isi
        password sendiri di sana. Role <code>master</code> gak bisa diberikan lewat undangan — harus
        manual lewat database.
      </p>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium uppercase text-slate-500">
            <th className="py-1.5">Email</th>
            <th className="py-1.5">Role</th>
            <th className="py-1.5">Status</th>
            <th className="py-1.5">Diundang oleh</th>
            <th className="py-1.5" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-slate-100">
              <td className="py-1.5">{entry.email}</td>
              <td className="py-1.5">
                <RoleBadges roles={entry.roles} />
              </td>
              <td className="py-1.5">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    entry.consumed_at ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {entry.consumed_at ? "Sudah signup" : "Menunggu"}
                </span>
              </td>
              <td className="py-1.5 text-slate-500">{entry.created_by}</td>
              <td className="py-1.5 text-right">
                {!entry.consumed_at && (
                  <Button
                    type="button"
                    variant="toolbar"
                    disabled={removingId === entry.id}
                    onClick={() => handleRemove(entry)}
                  >
                    Hapus
                  </Button>
                )}
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-center text-slate-400">
                Belum ada undangan.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Undang User Baru">
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nama@perusahaan.com"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Role</Label>
            <div className="flex flex-wrap gap-3">
              {ASSIGNABLE_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input type="radio" name="invite-role" checked={role === r} onChange={() => setRole(r)} />
                  {roleLabel[r]}
                </label>
              ))}
            </div>
          </div>
          {error && <FormError>{error}</FormError>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "..." : "+ Undang"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

const userManagementTabs: TabDef[] = [
  { key: "users", label: "Pengguna" },
  { key: "whitelist", label: "Whitelist" },
];

export default function UserManagementPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [isMaster, setIsMaster] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(userManagementTabs[0].key);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      const { data: roleRows } = await supabase
        .from("user_roles")
        .select("role_name")
        .eq("user_id", session.user.id);
      if (!active) return;
      setIsMaster(((roleRows ?? []) as { role_name: string }[]).some((r) => r.role_name === "master"));
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!isMaster) {
    return <FormError>Halaman ini cuma bisa diakses role master.</FormError>;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">User Management</h1>
        <p className="text-sm text-slate-500">
          Kelola siapa yang boleh registrasi dan role apa yang mereka pegang.
        </p>
      </div>
      <Tabs tabs={userManagementTabs} active={activeTab} onChange={setActiveTab} />
      {activeTab === "users" && <UsersPanel />}
      {activeTab === "whitelist" && <WhitelistPanel />}
    </div>
  );
}
