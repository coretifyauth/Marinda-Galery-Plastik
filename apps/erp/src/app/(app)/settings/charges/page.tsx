"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { TaxSettings } from "@/lib/tax-settings/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

type CatalogTable = "pos_charge_types" | "ar_invoice_charge_types" | "ap_bill_expense_categories";

type CatalogRow = {
  id: string;
  name: string;
  account_id: string;
  archived_at: string | null;
  accounts: { code: string; name: string };
};

/** Kelola 1 katalog "jenis biaya tambahan" — komponen generik, dipakai 3x (POS/AR/AP) karena
 * struktur ketiga tabel identik (memory/scope-debt/compound-transactional-entries.md). */
function CatalogManager({
  table,
  title,
  accounts,
  canWrite,
}: {
  table: CatalogTable;
  title: string;
  accounts: Account[];
  canWrite: boolean;
}) {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from(table)
      .select("id, name, account_id, archived_at, accounts(code, name)")
      .order("name");
    setRows((data ?? []) as unknown as CatalogRow[]);
  }, [table]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !accountId) {
      setError("Nama dan akun wajib diisi");
      return;
    }
    setSubmitting(true);
    const { error: err } = await supabase.from(table).insert({ name, account_id: accountId });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setName("");
    setAccountId("");
    await load();
  }

  async function toggleArchive(row: CatalogRow) {
    await supabase
      .from(table)
      .update({ archived_at: row.archived_at ? null : new Date().toISOString() })
      .eq("id", row.id);
    await load();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 font-semibold text-black">{title}</h2>
      <table className="mb-3 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium uppercase text-slate-500">
            <th className="py-1.5">Nama</th>
            <th className="py-1.5">Akun</th>
            <th className="py-1.5">Status</th>
            {canWrite && <th className="py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-slate-100">
              <td className="py-1.5">{row.name}</td>
              <td className="py-1.5">
                {row.accounts.code} — {row.accounts.name}
              </td>
              <td className="py-1.5">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    row.archived_at ? "bg-slate-100 text-slate-400" : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {row.archived_at ? "Nonaktif" : "Aktif"}
                </span>
              </td>
              {canWrite && (
                <td className="py-1.5 text-right">
                  <Button type="button" variant="toolbar" onClick={() => toggleArchive(row)}>
                    {row.archived_at ? "Aktifkan" : "Nonaktifkan"}
                  </Button>
                </td>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-center text-slate-400">
                Belum ada kategori.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {canWrite && (
        <form onSubmit={handleCreate} className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor={`${table}-name`}>Nama Kategori</Label>
            <Input
              id={`${table}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="mis. Biaya Packing"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor={`${table}-account`}>Akun</Label>
            <Select id={`${table}-account`} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Pilih akun...</option>
              {leafAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={submitting}>
            {submitting ? "..." : "+ Tambah"}
          </Button>
        </form>
      )}
      {error && <FormError>{error}</FormError>}
    </div>
  );
}

function TaxSettingsCard({ canWrite }: { canWrite: boolean }) {
  const [settings, setSettings] = useState<TaxSettings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isActive, setIsActive] = useState(false);
  const [rate, setRate] = useState("11");
  const [keluaranId, setKeluaranId] = useState("");
  const [masukanId, setMasukanId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const [{ data: ts }, { data: acc }] = await Promise.all([
      supabase.from("tax_settings").select("*").maybeSingle(),
      supabase
        .from("accounts")
        .select("id, code, name, category, normal_balance, parent_id, archived_at")
        .order("code"),
    ]);
    setAccounts((acc ?? []) as Account[]);
    if (ts) {
      const t = ts as TaxSettings;
      setSettings(t);
      setIsActive(t.is_active);
      setRate(String(t.ppn_rate));
      setKeluaranId(t.ppn_keluaran_account_id ?? "");
      setMasukanId(t.ppn_masukan_account_id ?? "");
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    const { error: err } = await supabase
      .from("tax_settings")
      .update({
        is_active: isActive,
        ppn_rate: Number(rate),
        ppn_keluaran_account_id: keluaranId || null,
        ppn_masukan_account_id: masukanId || null,
      })
      .eq("id", true);
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSaved(true);
    await load();
  }

  if (!settings) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 font-semibold text-black">Pengaturan Pajak (PPN)</h2>
      <form onSubmit={handleSave} className="flex flex-col gap-3">
        <label className="flex w-fit items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            disabled={!canWrite}
          />
          Kios ini wajib pungut PPN (PKP)
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ppn_rate">Tarif PPN (%)</Label>
            <Input
              id="ppn_rate"
              type="number"
              min="0"
              step="0.5"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              disabled={!canWrite}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ppn_keluaran">Akun PPN Keluaran (AR/POS)</Label>
            <Select
              id="ppn_keluaran"
              value={keluaranId}
              onChange={(e) => setKeluaranId(e.target.value)}
              disabled={!canWrite}
            >
              <option value="">Pilih akun...</option>
              {leafAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ppn_masukan">Akun PPN Masukan (AP)</Label>
            <Select
              id="ppn_masukan"
              value={masukanId}
              onChange={(e) => setMasukanId(e.target.value)}
              disabled={!canWrite}
            >
              <option value="">Pilih akun...</option>
              {leafAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {canWrite && (
          <Button type="submit" disabled={submitting} className="w-fit">
            {submitting ? "Menyimpan..." : "Simpan Pengaturan Pajak"}
          </Button>
        )}
        {saved && <p className="text-sm text-emerald-600">Tersimpan.</p>}
        {error && <FormError>{error}</FormError>}
      </form>
    </div>
  );
}

export default function ChargesSettingsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase
      .from("accounts")
      .select("id, code, name, category, normal_balance, parent_id, archived_at")
      .order("code");
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

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin");

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Kategori & Pajak</h1>
        <p className="text-sm text-slate-500">
          Setup katalog kategori biaya tambahan (POS/AR/AP) dan pengaturan PPN.{" "}
          {!canWrite && "Cuma role admin yang bisa ubah — kamu cuma bisa lihat."}
        </p>
      </div>
      <CatalogManager
        table="pos_charge_types"
        title="Kategori Biaya Tambahan — POS"
        accounts={accounts}
        canWrite={canWrite}
      />
      <CatalogManager
        table="ar_invoice_charge_types"
        title="Kategori Pendapatan Tambahan — AR Invoice"
        accounts={accounts}
        canWrite={canWrite}
      />
      <CatalogManager
        table="ap_bill_expense_categories"
        title="Kategori Beban/Persediaan Tambahan — AP Bill"
        accounts={accounts}
        canWrite={canWrite}
      />
      <TaxSettingsCard canWrite={canWrite} />
    </div>
  );
}
