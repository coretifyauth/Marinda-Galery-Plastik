"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  accountCategories,
  createAccountSchema,
  type Account,
} from "@/lib/accounts/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type TreeNode = Account & { children: TreeNode[] };

function buildTree(accounts: Account[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  accounts.forEach((a) => byId.set(a.id, { ...a, children: [] }));
  const roots: TreeNode[] = [];
  byId.forEach((node) => {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <>
      <tr className="border-b border-slate-100 text-sm hover:bg-slate-50">
        <td className="w-8 py-2 pl-4">
          <input type="checkbox" className="rounded border-slate-300" />
        </td>
        <td className="py-2 pr-4 font-mono" style={{ paddingLeft: depth * 20 }}>
          {node.code}
        </td>
        <td className="py-2 pr-4">{node.name}</td>
        <td className="py-2 pr-4 capitalize">{node.category}</td>
        <td className="py-2 pr-4 capitalize">{node.normal_balance}</td>
      </tr>
      {node.children.map((child) => (
        <TreeRow key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

function countNodes(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

export default function AccountsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] =
    useState<(typeof accountCategories)[number]>("asset");
  const [parentId, setParentId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>("");

  const loadAccounts = useCallback(async () => {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, code, name, category, normal_balance, parent_id, archived_at")
      .order("code");
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setAccounts((data ?? []) as Account[]);
  }, []);

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
      setRoles(((roleRows ?? []) as { role_name: string }[]).map((r) => r.role_name));
      await loadAccounts();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadAccounts]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = createAccountSchema.safeParse({
      code,
      name,
      category,
      parent_id: parentId || null,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from("accounts").insert(parsed.data);
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    setCode("");
    setName("");
    setParentId("");
    setShowForm(false);
    await loadAccounts();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const filteredAccounts = categoryFilter
    ? accounts.filter((a) => a.category === categoryFilter)
    : accounts;
  const tree = buildTree(filteredAccounts);
  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Chart of Accounts — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0
            ? roles.join(", ")
            : "belum ada role — cuma bisa lihat, gak bisa nambah akun"}
        </p>
      </div>

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Chart of Accounts</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {countNodes(tree)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => setShowFilter((v) => !v)}>
              Filter
            </Button>
            <Button variant="toolbar" onClick={() => loadAccounts()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm((v) => !v)}>
                + New
              </Button>
            )}
          </div>
        </div>

        {showFilter && (
          <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2">
            <Label htmlFor="category_filter" className="text-xs">
              Kategori
            </Label>
            <Select
              id="category_filter"
              className="w-40"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="">Semua</option>
              {accountCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        )}

        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="w-8 py-2 pl-4" />
              <th className="py-2 pr-4">Kode</th>
              <th className="py-2 pr-4">Nama</th>
              <th className="py-2 pr-4">Kategori</th>
              <th className="py-2 pr-4">Normal Balance</th>
            </tr>
          </thead>
          <tbody>
            {tree.map((node) => (
              <TreeRow key={node.id} node={node} depth={0} />
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Tambah Akun</h2>
          {!canWrite && (
            <p className="mb-4 text-sm text-amber-600">
              Kamu belum punya role admin/accountant — submit di bawah kemungkinan
              bakal ketolak RLS. Ini expected behavior, bukan bug (lihat
              docs/story/chart-of-accounts.md).
            </p>
          )}
          <form onSubmit={handleCreate} className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code">Kode</Label>
            <Input
              id="code"
              placeholder="mis. 1500"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Nama akun</Label>
            <Input
              id="name"
              placeholder="Nama akun"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category">Kategori</Label>
            <Select
              id="category"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as (typeof accountCategories)[number])
              }
            >
              {accountCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="parent">Akun induk</Label>
            <Select id="parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Tanpa parent (header baru)</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Menyimpan..." : "Simpan"}
          </Button>
        </form>
          {formError && (
            <div className="mt-3">
              <FormError>{formError}</FormError>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
