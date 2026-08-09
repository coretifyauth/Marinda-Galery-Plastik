"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { getLeafAccounts, type Account } from "@/lib/accounts/schema";
import { forfeitArDepositSchema, refundArDepositSchema, depositStatus, type ArDeposit } from "@/lib/ar-deposits/schema";
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

const statusLabel: Record<string, string> = {
  belum_dipakai: "Belum Dipakai",
  sebagian: "Sebagian Terpakai",
  selesai: "Selesai",
};

const statusStyle: Record<string, string> = {
  belum_dipakai: "bg-slate-100 text-slate-600",
  sebagian: "bg-amber-50 text-amber-700",
  selesai: "bg-emerald-50 text-emerald-700",
};

export function ArDepositDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [deposit, setDeposit] = useState<ArDeposit | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [journalEntries, setJournalEntries] = useState<JournalEntryDetail[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundDate, setRefundDate] = useState("");
  const [refundSourceRef, setRefundSourceRef] = useState("");
  const [refundDepositLiabilityAccountId, setRefundDepositLiabilityAccountId] = useState("");
  const [refundCashAccountId, setRefundCashAccountId] = useState("");
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  const [showForfeitForm, setShowForfeitForm] = useState(false);
  const [forfeitAmount, setForfeitAmount] = useState("");
  const [forfeitDate, setForfeitDate] = useState("");
  const [forfeitSourceRef, setForfeitSourceRef] = useState("");
  const [forfeitDepositLiabilityAccountId, setForfeitDepositLiabilityAccountId] = useState("");
  const [forfeitOtherRevenueAccountId, setForfeitOtherRevenueAccountId] = useState("");
  const [forfeitError, setForfeitError] = useState<string | null>(null);
  const [forfeitSubmitting, setForfeitSubmitting] = useState(false);

  const leafAccounts = getLeafAccounts(accounts);

  const load = useCallback(async () => {
    const { data: dep, error: depErr } = await supabase
      .from("ar_deposits")
      .select(
        "id, customer_id, deposit_date, source_ref, amount, journal_entry_id, created_at, customers(name), ar_deposit_applications(id, amount, source_ref, journal_entry_id, ar_invoices(source_ref)), ar_deposit_refunds(id, amount, refund_date, source_ref, journal_entry_id), ar_deposit_forfeitures(id, amount, forfeiture_date, source_ref, journal_entry_id)"
      )
      .eq("id", id)
      .single();
    if (depErr || !dep) {
      setLoadError(depErr?.message ?? "Deposit gak ditemukan.");
      return;
    }
    const loadedDeposit = dep as unknown as ArDeposit;
    setDeposit(loadedDeposit);

    const [{ data: accs }, { data: reversedRows }, { data: entries, error: entriesErr }] = await Promise.all([
      supabase
        .from("accounts")
        .select("id, code, name, category, normal_balance, parent_id, archived_at")
        .order("code"),
      supabase
        .from("journal_entries")
        .select("reverses_entry_id")
        .not("reverses_entry_id", "is", null),
      supabase
        .from("journal_entries")
        .select(
          "id, entry_date, description, source_ref, reverses_entry_id, journal_lines(id, debit, credit, accounts(code, name))"
        )
        .or(`id.eq.${loadedDeposit.journal_entry_id},reverses_entry_id.eq.${loadedDeposit.journal_entry_id}`)
        .order("entry_date"),
    ]);

    setAccounts((accs ?? []) as Account[]);
    setReversedEntryIds(
      new Set(((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
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
    setRefundDepositLiabilityAccountId("");
    setRefundCashAccountId("");
    setShowRefundForm(true);
  }

  async function handleRefundSubmit(e: FormEvent) {
    e.preventDefault();
    if (!deposit) return;
    setRefundError(null);

    const parsed = refundArDepositSchema.safeParse({
      deposit_id: deposit.id,
      amount: refundAmount,
      refund_date: refundDate,
      source_ref: refundSourceRef,
      deposit_liability_account_id: refundDepositLiabilityAccountId,
      cash_account_id: refundCashAccountId,
    });
    if (!parsed.success) {
      setRefundError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setRefundSubmitting(true);
    const { error } = await supabase.rpc("refund_ar_deposit", {
      p_deposit_id: parsed.data.deposit_id,
      p_amount: parsed.data.amount,
      p_refund_date: parsed.data.refund_date,
      p_source_ref: parsed.data.source_ref,
      p_deposit_liability_account_id: parsed.data.deposit_liability_account_id,
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

  function openForfeitForm() {
    setForfeitError(null);
    setForfeitAmount("");
    setForfeitDate("");
    setForfeitSourceRef("");
    setForfeitDepositLiabilityAccountId("");
    setForfeitOtherRevenueAccountId("");
    setShowForfeitForm(true);
  }

  async function handleForfeitSubmit(e: FormEvent) {
    e.preventDefault();
    if (!deposit) return;
    setForfeitError(null);

    const parsed = forfeitArDepositSchema.safeParse({
      deposit_id: deposit.id,
      amount: forfeitAmount,
      forfeiture_date: forfeitDate,
      source_ref: forfeitSourceRef,
      deposit_liability_account_id: forfeitDepositLiabilityAccountId,
      other_revenue_account_id: forfeitOtherRevenueAccountId,
    });
    if (!parsed.success) {
      setForfeitError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setForfeitSubmitting(true);
    const { error } = await supabase.rpc("forfeit_ar_deposit", {
      p_deposit_id: parsed.data.deposit_id,
      p_amount: parsed.data.amount,
      p_forfeiture_date: parsed.data.forfeiture_date,
      p_source_ref: parsed.data.source_ref,
      p_deposit_liability_account_id: parsed.data.deposit_liability_account_id,
      p_other_revenue_account_id: parsed.data.other_revenue_account_id,
    });
    setForfeitSubmitting(false);
    if (error) {
      setForfeitError(error.message);
      return;
    }

    setShowForfeitForm(false);
    await load();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!deposit) {
    return <FormError>{loadError ?? "Deposit gak ditemukan."}</FormError>;
  }

  const { status, applied, refunded, forfeited, remaining } = depositStatus(deposit, reversedEntryIds);
  const canWrite = roles.includes("admin") || roles.includes("accountant");
  const canSpend = canWrite && remaining > 0.005;
  const activeApplications = deposit.ar_deposit_applications.filter(
    (a) => !reversedEntryIds.has(a.journal_entry_id)
  );
  const reversedApplications = deposit.ar_deposit_applications.filter((a) =>
    reversedEntryIds.has(a.journal_entry_id)
  );

  return (
    <div className="flex w-full max-w-4xl flex-1 flex-col gap-6">
      <BackLink href="/ar-deposits" label="Kembali ke AR Deposits" />
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-black">
              {deposit.customers.name} — {deposit.source_ref}
            </h1>
            <span className={`rounded-full px-2 py-0.5 text-xs ${statusStyle[status]}`}>
              {statusLabel[status]}
            </span>
          </div>
          <p className="text-sm text-slate-500">{deposit.deposit_date}</p>
        </div>
        <div className="flex items-start gap-4">
          <div className="text-right">
            <div className="text-xs uppercase text-slate-400">Sisa Belum Dipakai</div>
            <div className="font-mono text-lg font-medium text-black">
              {remaining.toLocaleString("id-ID")}
            </div>
          </div>
          {canSpend && (
            <div className="flex gap-1.5">
              <Button variant="toolbar" onClick={() => (showRefundForm ? setShowRefundForm(false) : openRefundForm())}>
                {showRefundForm ? "Batal Refund" : "Refund Tunai"}
              </Button>
              <Button variant="toolbar" onClick={() => (showForfeitForm ? setShowForfeitForm(false) : openForfeitForm())}>
                {showForfeitForm ? "Batal Hanguskan" : "Hanguskan"}
              </Button>
            </div>
          )}
        </div>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
          <div>
            <dt className="text-xs uppercase text-slate-400">Jumlah Deposit</dt>
            <dd className="font-mono text-black">{deposit.amount.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Diterapkan</dt>
            <dd className="font-mono text-black">{applied.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Direfund</dt>
            <dd className="font-mono text-black">{refunded.toLocaleString("id-ID")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">Hangus</dt>
            <dd className="font-mono text-black">{forfeited.toLocaleString("id-ID")}</dd>
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
                    <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                      Reversal
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">{entry.source_ref}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {entry.journal_lines.map((line) => (
                      <li key={line.id}>
                        {line.accounts.code} {line.accounts.name} —{" "}
                        {line.debit > 0
                          ? `D ${line.debit.toLocaleString("id-ID")}`
                          : `K ${line.credit.toLocaleString("id-ID")}`}
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
          <span className="text-sm font-medium text-black">Diterapkan ke Invoice</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {deposit.ar_deposit_applications.length}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Source Ref</th>
              <th className="px-4 py-2">Invoice</th>
              <th className="px-4 py-2 text-right">Nominal</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {activeApplications.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2">{a.source_ref}</td>
                <td className="px-4 py-2">{a.ar_invoices.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">{a.amount.toLocaleString("id-ID")}</td>
                <td className="px-4 py-2">
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">Aktif</span>
                </td>
              </tr>
            ))}
            {reversedApplications.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 text-slate-400 hover:bg-slate-50">
                <td className="px-4 py-2 line-through">{a.source_ref}</td>
                <td className="px-4 py-2 line-through">{a.ar_invoices.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono line-through">
                  {a.amount.toLocaleString("id-ID")}
                </td>
                <td className="px-4 py-2">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                    Dibatalkan (invoice-nya dibatalkan)
                  </span>
                </td>
              </tr>
            ))}
            {deposit.ar_deposit_applications.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum pernah diterapkan.
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
            {deposit.ar_deposit_refunds.length}
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
            {deposit.ar_deposit_refunds.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{r.refund_date}</td>
                <td className="px-4 py-2">{r.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">{r.amount.toLocaleString("id-ID")}</td>
              </tr>
            ))}
            {deposit.ar_deposit_refunds.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                  Belum pernah direfund.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Hangus</span>
          <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
            {deposit.ar_deposit_forfeitures.length}
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
            {deposit.ar_deposit_forfeitures.map((f) => (
              <tr key={f.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2">{f.forfeiture_date}</td>
                <td className="px-4 py-2">{f.source_ref}</td>
                <td className="px-4 py-2 text-right font-mono">{f.amount.toLocaleString("id-ID")}</td>
              </tr>
            ))}
            {deposit.ar_deposit_forfeitures.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                  Belum pernah hangus.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showRefundForm && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Refund Tunai Uang Muka</h2>
          <p className="mb-4 text-sm text-slate-600">
            Balikin sisa deposit ini ke customer dalam bentuk kas/bank — gak ada dampak Laba
            Rugi, murni reklasifikasi aset. Boleh sebagian (sisanya bisa diterapkan/direfund
            lagi/hangus belakangan).
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
                  placeholder="mis. Refund-DP-001"
                  value={refundSourceRef}
                  onChange={(e) => setRefundSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund_deposit_liability_account">Akun Uang Muka Penjualan (debit)</Label>
                <Select
                  id="refund_deposit_liability_account"
                  value={refundDepositLiabilityAccountId}
                  onChange={(e) => setRefundDepositLiabilityAccountId(e.target.value)}
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
                <Label htmlFor="refund_cash_account">Akun Kas/Bank (kredit)</Label>
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
            </div>

            {refundError && <FormError>{refundError}</FormError>}

            <Button type="submit" disabled={refundSubmitting} className="w-fit">
              {refundSubmitting ? "Menyimpan..." : "Refund"}
            </Button>
          </form>
        </div>
      )}

      {showForfeitForm && (
        <div className="rounded-xl border border-red-200 bg-red-50/40 p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Hanguskan Deposit</h2>
          <p className="mb-4 text-sm text-slate-600">
            Sisa deposit dihanguskan — jadi Pendapatan Lain-lain, bukan Pendapatan Penjualan.
            Boleh sebagian.
          </p>
          <form onSubmit={handleForfeitSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="forfeit_amount">Nominal Hangus (maks {remaining.toLocaleString("id-ID")})</Label>
                <Input
                  id="forfeit_amount"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={forfeitAmount}
                  onChange={(e) => setForfeitAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="forfeit_date">Tanggal</Label>
                <Input
                  id="forfeit_date"
                  type="date"
                  value={forfeitDate}
                  onChange={(e) => setForfeitDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="forfeit_source_ref">Rujukan dokumen</Label>
                <Input
                  id="forfeit_source_ref"
                  placeholder="mis. Pembatalan pesanan"
                  value={forfeitSourceRef}
                  onChange={(e) => setForfeitSourceRef(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="forfeit_deposit_liability_account">Akun Uang Muka Penjualan (debit)</Label>
                <Select
                  id="forfeit_deposit_liability_account"
                  value={forfeitDepositLiabilityAccountId}
                  onChange={(e) => setForfeitDepositLiabilityAccountId(e.target.value)}
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
                <Label htmlFor="forfeit_other_revenue_account">Akun Pendapatan Lain-lain (kredit)</Label>
                <Select
                  id="forfeit_other_revenue_account"
                  value={forfeitOtherRevenueAccountId}
                  onChange={(e) => setForfeitOtherRevenueAccountId(e.target.value)}
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

            {forfeitError && <FormError>{forfeitError}</FormError>}

            <Button type="submit" disabled={forfeitSubmitting} className="w-fit">
              {forfeitSubmitting ? "Memproses..." : "Hanguskan"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
