"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import type { Supplier } from "@/lib/suppliers/schema";
import { createApBillSchema, billStatus, type ApBill } from "@/lib/ap-bills/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

const statusStyle: Record<string, string> = {
  lunas: "bg-emerald-50 text-emerald-700",
  sebagian: "bg-amber-50 text-amber-700",
  belum: "bg-slate-100 text-slate-600",
  dibatalkan: "bg-slate-100 text-slate-400 line-through",
};

export default function ApBillsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [bills, setBills] = useState<ApBill[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const [supplierId, setSupplierId] = useState("");
  const [billDate, setBillDate] = useState("");
  const [description, setDescription] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [amount, setAmount] = useState("");
  const [debitAccountId, setDebitAccountId] = useState("");
  const [payableAccountId, setPayableAccountId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const loadReversedEntryIds = useCallback(async () => {
    const { data } = await supabase
      .from("journal_entries")
      .select("reverses_entry_id")
      .not("reverses_entry_id", "is", null);
    setReversedEntryIds(
      new Set(((data ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
  }, []);

  const loadBills = useCallback(async () => {
    const { data, error } = await supabase
      .from("ap_bills")
      .select(
        "id, supplier_id, bill_date, due_date, description, source_ref, amount, journal_entry_id, created_at, suppliers(name), ap_payment_allocations(amount)"
      )
      .order("bill_date", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setBills((data ?? []) as unknown as ApBill[]);
  }, []);

  const loadSuppliers = useCallback(async () => {
    const { data } = await supabase
      .from("suppliers")
      .select("id, name, contact, payment_term_days, archived_at")
      .order("name");
    setSuppliers((data ?? []) as Supplier[]);
  }, []);

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
      await Promise.all([loadSuppliers(), loadAccounts(), loadBills(), loadReversedEntryIds()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadSuppliers, loadAccounts, loadBills, loadReversedEntryIds]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createApBillSchema.safeParse({
      supplier_id: supplierId,
      bill_date: billDate,
      description,
      source_ref: sourceRef,
      amount,
      debit_account_id: debitAccountId,
      payable_account_id: payableAccountId,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.rpc("create_ap_bill", {
      p_supplier_id: parsed.data.supplier_id,
      p_bill_date: parsed.data.bill_date,
      p_description: parsed.data.description || null,
      p_source_ref: parsed.data.source_ref,
      p_amount: parsed.data.amount,
      p_debit_account_id: parsed.data.debit_account_id,
      p_payable_account_id: parsed.data.payable_account_id,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }

    setSupplierId("");
    setBillDate("");
    setDescription("");
    setSourceRef("");
    setAmount("");
    setDebitAccountId("");
    setPayableAccountId("");
    setShowForm(false);
    await loadBills();
  }

  async function handleCancel(bill: ApBill) {
    const reasonRef = window.prompt(
      `Batalkan bill ${bill.source_ref} (Rp${bill.amount.toLocaleString("id-ID")})?\nMasukin rujukan dokumen buat entry pembalik:`,
      `Pembatalan ${bill.source_ref}`
    );
    if (!reasonRef) return;

    setCancelError(null);
    setCancellingId(bill.id);
    const { error } = await supabase.rpc("cancel_ap_bill", {
      p_bill_id: bill.id,
      p_entry_date: new Date().toISOString().slice(0, 10),
      p_source_ref: reasonRef,
    });
    setCancellingId(null);
    if (error) {
      setCancelError(error.message);
      return;
    }
    await Promise.all([loadBills(), loadReversedEntryIds()]);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">AP Bills — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {cancelError && <FormError>{cancelError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">AP Bills</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {bills.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadBills()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm((v) => !v)}>
                + New
              </Button>
            )}
          </div>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Jatuh Tempo</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
              <th className="px-4 py-2 text-right">Outstanding</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {bills.map((bill) => {
              const isCancelled = reversedEntryIds.has(bill.journal_entry_id);
              const { status, outstanding, allocated } = billStatus(bill, isCancelled);
              const overdue =
                status !== "lunas" && status !== "dibatalkan" && bill.due_date < new Date().toISOString().slice(0, 10);
              const canCancel = canWrite && !isCancelled && allocated === 0;
              return (
                <tr key={bill.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-black">{bill.suppliers.name}</td>
                  <td className="whitespace-nowrap px-4 py-2">{bill.bill_date}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {bill.due_date}
                    {overdue && (
                      <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">
                        Telat
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{bill.source_ref}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {bill.amount.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {outstanding.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusStyle[status]}`}>
                      {status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canCancel && (
                      <button
                        type="button"
                        onClick={() => handleCancel(bill)}
                        disabled={cancellingId === bill.id}
                        className="text-xs text-red-600 hover:underline disabled:opacity-40"
                      >
                        {cancellingId === bill.id ? "Membatalkan..." : "Batalkan"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {bills.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-400">
                  Belum ada bill.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Tambah AP Bill</h2>
          {!canWrite && (
            <p className="mb-4 text-sm text-amber-600">
              Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
              ketolak RLS.
            </p>
          )}
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="supplier">Supplier</Label>
                <Select id="supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">Pilih supplier...</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} (net-{s.payment_term_days})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bill_date">Tanggal</Label>
                <Input
                  id="bill_date"
                  type="date"
                  value={billDate}
                  onChange={(e) => setBillDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source_ref">Rujukan dokumen (source_ref)</Label>
                <Input
                  id="source_ref"
                  placeholder="mis. Nota beli #SUP-026"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="description">Deskripsi</Label>
                <Input
                  id="description"
                  placeholder="mis. Ambil tepung dari Toko Tepung Makmur"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="amount">Jumlah</Label>
                <Input
                  id="amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="debit_account">Akun Persediaan/Beban (debit)</Label>
                <Select id="debit_account" value={debitAccountId} onChange={(e) => setDebitAccountId(e.target.value)}>
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payable_account">Akun Utang Usaha (kredit)</Label>
                <Select
                  id="payable_account"
                  value={payableAccountId}
                  onChange={(e) => setPayableAccountId(e.target.value)}
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

            {formError && <FormError>{formError}</FormError>}

            <Button type="submit" disabled={submitting} className="w-fit">
              {submitting ? "Menyimpan..." : "Simpan Bill"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
