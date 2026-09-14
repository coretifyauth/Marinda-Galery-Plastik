"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { accountCategories, type Account } from "@/lib/accounts/schema";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { LoadingScreen } from "@/components/ui/loading-screen";

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
  const router = useRouter();
  return (
    <>
      <tr
        className="cursor-pointer border-b border-slate-100 text-sm hover:bg-slate-50"
        onClick={() => router.push(`/accounts/${node.id}`)}
      >
        <td className="w-8 py-2 pl-4" onClick={(e) => e.stopPropagation()}>
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
        .from("app_user_roles")
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

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const filteredAccounts = categoryFilter
    ? accounts.filter((a) => a.category === categoryFilter)
    : accounts;
  const tree = buildTree(filteredAccounts);
  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Chart of Accounts</h1>
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
              Muat Ulang
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => router.push("/accounts/new")}>
                + Tambah
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
    </div>
  );
}
