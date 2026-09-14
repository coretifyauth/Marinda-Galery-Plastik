"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { fetchWalkInCustomerId } from "@/lib/pos-settings/schema";
import type { Customer } from "@/lib/customers/schema";
import { createArDepositSchema, type CreateArDepositInput } from "@/lib/ar-deposits/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { CashMethodField, resolveCashAccount, type CashMethod } from "@/components/ui/cash-method-field";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function NewArDepositPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  const [customerId, setCustomerId] = useState("");
  const [depositDate, setDepositDate] = useState("");
  const [amount, setAmount] = useState("");
  const [cashMethod, setCashMethod] = useState<CashMethod>("TUNAI");
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const loadCustomers = useCallback(async () => {
    const walkInCustomerId = await fetchWalkInCustomerId();
    let query = supabase
      .from("counterparties")
      .select("id, name, contact, payment_term_days, archived_at, counterparty_type_mapping!inner(role)")
      .eq("counterparty_type_mapping.role", "customer")
      .order("name");
    if (walkInCustomerId) query = query.neq("id", walkInCustomerId);
    const { data } = await query;
    setCustomers((data ?? []) as unknown as Customer[]);
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
      await Promise.all([loadCustomers(), fetchDefaultAccounts().then(setDefaultAccounts)]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCustomers]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateArDepositInput) => {
      const sourceRef = await generateDocumentNumber("ar_deposits");
      const { data, error } = await supabase.rpc("create_deposit", {
        p_type: "OUTBOUND",
        p_counterparty_id: input.customer_id,
        p_deposit_date: input.deposit_date,
        p_source_ref: sourceRef,
        p_amount: input.amount,
        p_cash_account_id: input.cash_account_id,
        p_deposit_account_id: input.deposit_liability_account_id,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: (newId) => {
      router.push(`/ar-deposits/${newId}`);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan uang muka");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsed = createArDepositSchema.safeParse({
      customer_id: customerId,
      deposit_date: depositDate,
      amount,
      cash_account_id: resolveCashAccount(cashMethod, defaultAccounts)?.id ?? "",
      deposit_liability_account_id: defaultAccounts["ar.deposit_liability"]?.id ?? "",
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    createMutation.mutate(parsed.data);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/ar-deposits" label="Kembali ke Uang Muka AR" />

      <div>
        <h1 className="text-xl font-semibold text-black">Terima Uang Muka</h1>
        <p className="text-sm text-slate-500">
          Uang muka/DP yang diterima dari pelanggan sebelum ada invoice — nanti diterapkan
          sebagai pengurang piutang begitu invoice-nya terbit.
        </p>
      </div>

      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customer">Pelanggan</Label>
                <Select id="customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">Pilih pelanggan...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="deposit_date">Tanggal</Label>
                  <Input
                    id="deposit_date"
                    type="date"
                    value={depositDate}
                    onChange={(e) => setDepositDate(e.target.value)}
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
              </div>
              <CashMethodField
                label="Akun Kas/Bank (debit)"
                htmlFor="cash_account"
                method={cashMethod}
                onChange={setCashMethod}
                defaultAccounts={defaultAccounts}
              />
              <LockedAccountField
                label="Akun Uang Muka Penjualan (kredit)"
                htmlFor="deposit_liability_account"
                resolved={defaultAccounts["ar.deposit_liability"]}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                {
                  label: "Akun Kas/Bank (debit)",
                  resolved: resolveCashAccount(cashMethod, defaultAccounts),
                  side: "debit",
                },
                {
                  label: "Akun Uang Muka Penjualan (kredit)",
                  resolved: defaultAccounts["ar.deposit_liability"],
                  side: "credit",
                },
              ],
            ]}
          />

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Uang Muka"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Batal
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
