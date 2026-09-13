"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { billStatus, type ApBill } from "@/lib/ap-bills/schema";
import { applyApDepositSchema, depositStatus, type ApDeposit } from "@/lib/ap-deposits/schema";
import { generateDocumentNumber } from "@/lib/document-numbers";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LockedAccountField } from "@/components/ui/locked-account-field";
import { JournalPreviewPanel } from "@/components/ui/journal-preview-panel";
import { fetchDefaultAccounts, type ResolvedAccount } from "@/lib/default-accounts/schema";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function ApBillTerapkanDpPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [bill, setBill] = useState<ApBill | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [isCancelled, setIsCancelled] = useState(false);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [supplierDeposits, setSupplierDeposits] = useState<ApDeposit[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [applyDepositId, setApplyDepositId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [applyDate, setApplyDate] = useState("");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySubmitting, setApplySubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data: b, error: billErr } = await supabase
      .from("transactions")
      .select(
        "id, supplier_id:counterparty_id, bill_date:date, due_date, description, source_ref, supplier_document_ref, amount, journal_entry_id, created_at, counterparties(name), ap_payments:payments(amount), ap_returns:returns(amount, ap_return_credits:return_credits(amount)), ap_deposit_applications:deposit_applications(amount)"
      )
      .eq("id", id)
      .eq("type", "INBOUND")
      .single();
    if (billErr || !b) {
      setLoadError(billErr?.message ?? "Bill gak ditemukan.");
      return;
    }
    const loadedBill = b as unknown as ApBill;
    setBill(loadedBill);

    const [defaultAccountsMap, { data: reversedRows }, { data: supDeposits, error: supDepositsErr }] =
      await Promise.all([
        fetchDefaultAccounts(),
        supabase
          .from("journal_entries")
          .select("reverses_entry_id")
          .not("reverses_entry_id", "is", null),
        supabase
          .from("deposits")
          .select(
            "id, supplier_id:counterparty_id, deposit_date, source_ref, amount, journal_entry_id, created_at, counterparties(name), ap_deposit_applications:deposit_applications(id, amount, source_ref, journal_entry_id, ap_bills:transactions(source_ref)), ap_deposit_refunds:deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ap_deposit_forfeitures:deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
          )
          .eq("counterparty_id", loadedBill.supplier_id)
          .eq("type", "INBOUND")
          .order("deposit_date"),
      ]);

    setDefaultAccounts(defaultAccountsMap);
    const reversedIds = new Set(
      ((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id)
    );
    setReversedEntryIds(reversedIds);
    setIsCancelled(reversedIds.has(loadedBill.journal_entry_id));
    setSupplierDeposits((supDeposits ?? []) as unknown as ApDeposit[]);
    setLoadError(supDepositsErr?.message ?? null);
  }, [id]);

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
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  async function handleApplySubmit(e: FormEvent) {
    e.preventDefault();
    if (!bill) return;
    setApplyError(null);

    const parsed = applyApDepositSchema.safeParse({
      deposit_id: applyDepositId,
      bill_id: bill.id,
      amount: applyAmount,
      entry_date: applyDate,
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      deposit_asset_account_id: defaultAccounts["ap.deposit_asset"]?.id ?? "",
    });
    if (!parsed.success) {
      setApplyError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setApplySubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ap_deposit_applications");
    } catch (err) {
      setApplySubmitting(false);
      setApplyError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("apply_deposit", {
      p_deposit_id: parsed.data.deposit_id,
      p_transaction_id: parsed.data.bill_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: sourceRef,
      p_control_account_id: parsed.data.payable_account_id,
      p_deposit_account_id: parsed.data.deposit_asset_account_id,
    });
    setApplySubmitting(false);
    if (error) {
      setApplyError(error.message);
      return;
    }

    router.push(`/ap-bills/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!bill) {
    return <FormError>{loadError ?? "Bill gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const { outstanding } = billStatus(bill, isCancelled);
  const availableDeposits = supplierDeposits.filter((dep) => depositStatus(dep, reversedEntryIds).remaining > 0.005);
  const selectedDeposit = availableDeposits.find((dep) => dep.id === applyDepositId) ?? null;
  const selectedDepositRemaining = selectedDeposit ? depositStatus(selectedDeposit, reversedEntryIds).remaining : 0;

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ap-bills/${id}`} label="Kembali ke Detail Tagihan" />

      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Terapkan DP ke Bill Ini</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {bill.source_ref}
          </span>
        </div>
        <p className="text-sm text-slate-500">
          Reklasifikasi uang muka yang udah dibayar ke supplier ini jadi pengurang utang bill ini — bukan pembayaran
          baru.
        </p>
      </div>

      {isCancelled && <FormError>Bill ini sudah dibatalkan.</FormError>}
      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}
      {availableDeposits.length === 0 && (
        <FormError>Supplier ini gak punya deposit yang masih bisa diterapkan.</FormError>
      )}

      <form onSubmit={handleApplySubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_deposit">Deposit</Label>
                <Select
                  id="apply_deposit"
                  value={applyDepositId}
                  onChange={(e) => {
                    setApplyDepositId(e.target.value);
                    const dep = availableDeposits.find((d) => d.id === e.target.value);
                    if (dep) {
                      const remaining = depositStatus(dep, reversedEntryIds).remaining;
                      setApplyAmount(String(Math.min(remaining, outstanding)));
                    }
                  }}
                >
                  <option value="">Pilih deposit...</option>
                  {availableDeposits.map((dep) => {
                    const remaining = depositStatus(dep, reversedEntryIds).remaining;
                    return (
                      <option key={dep.id} value={dep.id}>
                        {dep.source_ref} (sisa {remaining.toLocaleString("id-ID")})
                      </option>
                    );
                  })}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_amount">
                  Nominal Diterapkan{" "}
                  {selectedDeposit &&
                    `(maks ${Math.min(selectedDepositRemaining, outstanding).toLocaleString("id-ID")})`}
                </Label>
                <Input
                  id="apply_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={applyAmount}
                  onChange={(e) => setApplyAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="apply_date">Tanggal</Label>
                <Input id="apply_date" type="date" value={applyDate} onChange={(e) => setApplyDate(e.target.value)} />
              </div>
              <LockedAccountField
                label="Akun Utang Usaha (debit)"
                htmlFor="apply_payable_account"
                resolved={defaultAccounts["ap.payable"]}
              />
              <LockedAccountField
                label="Akun Uang Muka Pembelian (kredit)"
                htmlFor="apply_deposit_asset_account"
                resolved={defaultAccounts["ap.deposit_asset"]}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                { label: "Akun Utang Usaha (debit)", resolved: defaultAccounts["ap.payable"], side: "debit" },
                {
                  label: "Akun Uang Muka Pembelian (kredit)",
                  resolved: defaultAccounts["ap.deposit_asset"],
                  side: "credit",
                },
              ],
            ]}
          />

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">Nominal Diterapkan</p>
            <p className="mt-1 font-mono text-2xl text-black">
              Rp{(Number(applyAmount) || 0).toLocaleString("id-ID")}
            </p>
          </div>

          {applyError && <FormError>{applyError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={applySubmitting}>
              {applySubmitting ? "Menyimpan..." : "Terapkan DP"}
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
