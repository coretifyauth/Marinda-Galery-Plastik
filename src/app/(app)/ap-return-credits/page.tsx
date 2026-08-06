"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { returnCreditRemaining, type ApReturnCredit } from "@/lib/ap-return-credits/schema";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

export default function ApReturnCreditsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [credits, setCredits] = useState<ApReturnCredit[]>([]);
  const [reversedEntryIds, setReversedEntryIds] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadReversedEntryIds = useCallback(async () => {
    const { data } = await supabase
      .from("journal_entries")
      .select("reverses_entry_id")
      .not("reverses_entry_id", "is", null);
    setReversedEntryIds(
      new Set(((data ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id))
    );
  }, []);

  const loadCredits = useCallback(async () => {
    const { data, error } = await supabase
      .from("ap_return_credits")
      .select(
        "id, supplier_id, credit_note_id, amount, journal_entry_id, created_at, suppliers(name), ap_credit_notes(source_ref, credit_note_date), ap_return_credit_applications(id, amount, source_ref, journal_entry_id, ap_bills(source_ref)), ap_return_credit_refunds(id, amount, source_ref, journal_entry_id, created_at)"
      )
      .order("created_at", { ascending: false });
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setCredits((data ?? []) as unknown as ApReturnCredit[]);
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
      await Promise.all([loadCredits(), loadReversedEntryIds()]);
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadCredits, loadReversedEntryIds]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  return (
    <div className="flex w-full max-w-5xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">AP Return Credit (Piutang Retur Supplier) — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu: {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}. Saldo lahir
          otomatis dari retur (Opsi A) yang bikin Utang Usaha bill jadi minus (retur setelah bill
          lunas) — gak ada form buat bikin baru di sini.
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">AP Return Credit</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {credits.length}
            </span>
          </div>
          <Button variant="toolbar" onClick={() => loadCredits()}>
            Refresh
          </Button>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Supplier</th>
              <th className="px-4 py-2">Source Retur</th>
              <th className="px-4 py-2">Tanggal</th>
              <th className="px-4 py-2 text-right">Jumlah Awal</th>
              <th className="px-4 py-2 text-right">Sudah Dipakai</th>
              <th className="px-4 py-2 text-right">Sisa</th>
            </tr>
          </thead>
          <tbody>
            {credits.map((credit) => {
              const { used, remaining } = returnCreditRemaining(credit, reversedEntryIds);
              return (
                <tr
                  key={credit.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => router.push(`/ap-return-credits/${credit.id}`)}
                >
                  <td className="px-4 py-2 font-medium text-black">{credit.suppliers.name}</td>
                  <td className="px-4 py-2">{credit.ap_credit_notes.source_ref}</td>
                  <td className="whitespace-nowrap px-4 py-2">{credit.ap_credit_notes.credit_note_date}</td>
                  <td className="px-4 py-2 text-right font-mono">{credit.amount.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2 text-right font-mono">{used.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-2 text-right font-mono font-medium text-black">
                    {remaining.toLocaleString("id-ID")}
                  </td>
                </tr>
              );
            })}
            {credits.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Belum ada saldo kredit retur.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
