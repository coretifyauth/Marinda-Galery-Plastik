"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import {
  refundApReturnCreditSchema,
  returnCreditRemaining,
  type ApReturnCredit,
} from "@/lib/ap-return-credits/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";

type JournalEntryDetail = {
  id: string;
  entry_date: string;
  description: string | null;
  source_ref: string;
  reverses_entry_id: string | null;
  journal_lines: { id: string; debit: number; credit: number; accounts: { code: string; name: string } }[];
};

export function ApReturnCreditDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [credit, setCredit] = useState<ApReturnCredit | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundDate, setRefundDate] = useState("");
  const [refundSourceRef, setRefundSourceRef] = useState("");
  const [refundCashAccountId, setRefundCashAccountId] = useState("");
  const [refundReturnCreditAssetAccountId, setRefundReturnCreditAssetAccountId] = useState("");
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const { data: cred, error: credErr } = await supabase
      .from("ap_return_credits")
      .select(
        "id, supplier_id, credit_note_id, amount, journal_entry_id, created_at, suppliers(name), ap_credit_notes(source_ref, credit_note_date), ap_return_credit_refunds(id, amount, source_ref, journal_entry_id, created_at)"
      )
      .eq("id", id)
      .single();
    if (credErr || !cred) {
      setLoadError(credErr?.message ?? "Saldo kredit retur gak ditemukan.");
      return;
    }
    const loadedCredit = cred as unknown as ApReturnCredit;
    setCredit(loadedCredit);

    const [{ data: accs }, { data: entries, error: entriesErr }] = await Promise.all([
      supabase
        .from("accounts")
        .select("id, code, name, category, normal_balance, parent_id, archived_at")
        .order("code"),
      supabase
        .from("journal_entries")
        .select(
          "id, entry_date, description, source_ref, reverses_entry_id, journal_lines(id, debit, credit, accounts(code, name))"
        )
        .or(`id.eq.${loadedCredit.journal_entry_id},reverses_entry_id.eq.${loadedCredit.journal_entry_id}`)
        .order("entry_date"),
    ]);

    setAccounts((accs ?? []) as Account[]);
    setJournalEntries((entries ?? []) as unknown as JournalEntryDetail[]);
    setLoadError(entriesErr?.message ?? null);
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

  function openRefundForm() {
    setRefundError(null);
    setRefundAmount("");
    setRefundDate("");
    setRefundSourceRef("");
    setRefundCashAccountId("");
    setRefundReturnCreditAssetAccountId("");
    setShowRefundForm(true);
  }

  async function handleRefundSubmit(e: FormEvent) {
    e.preventDefault();
    if (!credit) return;
    setRefundError(null);

    const parsed = refundApReturnCreditSchema.safeParse({
      credit_id: credit.id,
      amount: refundAmount,
      entry_date: refundDate,
      source_ref: refundSourceRef,
      return_credit_asset_account_id: refundReturnCreditAssetAccountId,
      cash_account_id: refundCashAccountId,
    });
    if (!parsed.success) {
      setRefundError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setRefundSubmitting(true);
    const { error } = await supabase.rpc("refund_ap_return_credit", {
      p_credit_id: parsed.data.credit_id,
      p_amount: parsed.data.amount,
      p_entry_date: parsed.data.entry_date,
      p_source_ref: parsed.data.source_ref,
      p_return_credit_asset_account_id: parsed.data.return_credit_asset_account_id,
      p_cash_account_id: parsed.data.cash_account_id,
    });
    setRefundSubmitting(false);
    if (error) {
      setRefundError(error.message);
      return;
    }

    setShowRefundForm(false);
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!credit) {
    return <FormError>{loadError ?? "Saldo kredit retur gak ditemukan."}</FormError>;
  }

  const { used, remaining } = returnCreditRemaining(credit);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canSpend = canWrite && remaining > 0.005;

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/ap-return-credits" label="Kembali ke AP Return Credit" />
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-black">
            {credit.suppliers.name} — {credit.ap_credit_notes.source_ref}
          </h1>
          <p className="text-sm text-slate-500">{credit.ap_credit_notes.credit_note_date}</p>
        </div>
        <div className="flex items-start gap-4">
          <div className="text-right">
            <div className="text-xs uppercase text-slate-400">Sisa Piutang Retur Supplier</div>
            <div className="font-mono text-lg font-medium text-black">{remaining.toLocaleString("id-ID")}</div>
          </div>
          {canSpend && (
            <div className="flex gap-1.5">
              <Button variant="toolbar" onClick={() => (showRefundForm ? setShowRefundForm(false) : openRefundForm())}>
                {showRefundForm ? "Batal Refund" : "Refund Tunai"}
              </Button>
            </div>
          )}
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-slate-400">Jumlah Awal</dt>
            <dd className="font-mono text-black">{credit.amount.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Sudah Direfund</dt>
            <dd className="font-mono text-black">{used.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Sisa</dt>
            <dd className="font-mono font-medium text-black">{remaining.toLocaleString("id-ID")}</dd>
          </div>
        </dl>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Jurnal Terkait</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {journalEntries.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Deskripsi</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Baris</th>
            </tr>
          </thead>
          <tbody>
            {journalEntries.map((entry) => (
              <tr key={entry.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{entry.entry_date}</td>
                <td className="px-4 py-2">
                  {entry.description}
                  {entry.reverses_entry_id && (
                    <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">Reversal</span>
                  )}
                </td>
                <td className="px-4 py-2">{entry.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {entry.journal_lines.map((line) => (
                      <li key={line.id}>
                        {line.accounts.code} {line.accounts.name} —{" "}
                        {line.debit > 0 ? `D ${line.debit.toLocaleString("id-ID")}` : `K ${line.credit.toLocaleString("id-ID")}`}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
            {journalEntries.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada jurnal.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Refund Tunai</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {credit.ap_return_credit_refunds.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2 text-right">Nominal</th>
            </tr>
          </thead>
          <tbody>
            {credit.ap_return_credit_refunds.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{r.created_at.slice(0, 10)}</td>
                <td className="px-4 py-2">{r.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">{r.amount.toLocaleString("id-ID")}</td>
              </tr>
            ))}
            {credit.ap_return_credit_refunds.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                  Belum pernah direfund.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showRefundForm && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Refund Tunai Piutang Retur Supplier</h2>
          <p className="mb-4 text-sm text-slate-600">
            Terima kembali sisa piutang retur ini dari supplier dalam bentuk kas/bank.
          </p>
          <form onSubmit={handleRefundSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_amount">Nominal Refund (maks {remaining.toLocaleString("id-ID")})</Label>
                <Input
                  id="refund_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_date">Tanggal</Label>
                <Input id="refund_date" type="date" value={refundDate} onChange={(e) => setRefundDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_source_ref">Rujukan dokumen</Label>
                <Input
                  id="refund_source_ref"
                  placeholder="mis. Refund-Kredit-Retur-001"
                  value={refundSourceRef}
                  onChange={(e) => setRefundSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_cash_account">Akun Kas/Bank (debit)</Label>
                <Select
                  id="refund_cash_account"
                  value={refundCashAccountId}
                  onChange={(e) => setRefundCashAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {leafAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_return_credit_asset_account">Akun Piutang Retur Supplier (kredit)</Label>
                <Select
                  id="refund_return_credit_asset_account"
                  value={refundReturnCreditAssetAccountId}
                  onChange={(e) => setRefundReturnCreditAssetAccountId(e.target.value)}
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

            {refundError && <FormError>{refundError}</FormError>}

            <Button type="submit" disabled={refundSubmitting} className="w-fit">
              {refundSubmitting ? "Menyimpan..." : "Refund"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
