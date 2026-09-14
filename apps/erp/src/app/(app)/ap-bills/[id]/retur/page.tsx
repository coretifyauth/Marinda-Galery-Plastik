"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { billStatus, type ApBill } from "@/lib/ap-bills/schema";
import { createApCreditNoteSchema, type GoodsReceiptForBill } from "@/lib/ap-credit-notes/schema";
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

type ReturnLineInput = {
  item_id: string;
  name: string;
  uom: string;
  unit_cost: number;
  qty_available: number;
  qty_returned: string;
};

type CreditNoteDetail = {
  id: string;
  return_lines: { item_id: string; qty_returned: number }[];
};

type ReplacementDetail = {
  id: string;
  replacement_lines: { item_id: string; qty_replaced: number }[];
};

export default function ApBillReturPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [bill, setBill] = useState<ApBill | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<Record<string, ResolvedAccount>>({});
  const [billDebitAccounts, setBillDebitAccounts] = useState<ResolvedAccount[]>([]);
  const [inventoryAccountIds, setInventoryAccountIds] = useState<Set<string>>(new Set());
  const [isCancelled, setIsCancelled] = useState(false);
  const [goodsReceipt, setGoodsReceipt] = useState<GoodsReceiptForBill | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [returDate, setReturDate] = useState("");
  const [returAmount, setReturAmount] = useState("");
  const [returCreditAccountId, setReturCreditAccountId] = useState("");
  const [returLines, setReturLines] = useState<ReturnLineInput[]>([]);
  const [returError, setReturError] = useState<string | null>(null);
  const [returSubmitting, setReturSubmitting] = useState(false);

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

    const [
      defaultAccountsMap,
      { data: debitLineRows },
      { data: itemAccountRows },
      { data: reversedRows },
      { data: cns, error: cnErr },
      { data: reps, error: repErr },
      { data: grn },
    ] = await Promise.all([
      fetchDefaultAccounts(),
      supabase
        .from("transaction_lines")
        .select("account_id, accounts(code, name)")
        .eq("transaction_id", id)
        .eq("is_tax", false),
      supabase.from("items").select("inventory_account_id"),
      supabase
        .from("journal_entries")
        .select("reverses_entry_id")
        .not("reverses_entry_id", "is", null),
      supabase
        .from("returns")
        .select("id, return_lines(item_id, qty_returned)")
        .eq("transaction_id", id)
        .eq("type", "OUTBOUND"),
      supabase
        .from("replacements")
        .select("id, replacement_lines(item_id, qty_replaced)")
        .eq("transaction_id", id)
        .eq("type", "OUTBOUND"),
      supabase
        .from("goods_notes")
        .select("id, goods_note_lines(item_id, qty, unit_cost, items(name, uom))")
        .eq("transaction_id", id)
        .eq("type", "INBOUND")
        .maybeSingle(),
    ]);

    setDefaultAccounts(defaultAccountsMap);
    const debitLines = (debitLineRows ?? []) as unknown as {
      account_id: string;
      accounts: { code: string; name: string };
    }[];
    const uniqueDebitAccounts = new Map<string, ResolvedAccount>();
    for (const l of debitLines) {
      uniqueDebitAccounts.set(l.account_id, { id: l.account_id, code: l.accounts.code, name: l.accounts.name });
    }
    setBillDebitAccounts(Array.from(uniqueDebitAccounts.values()));
    const inventoryIds = new Set(
      ((itemAccountRows ?? []) as { inventory_account_id: string }[]).map((r) => r.inventory_account_id)
    );
    setInventoryAccountIds(inventoryIds);
    const reversedIds = new Set(
      ((reversedRows ?? []) as { reverses_entry_id: string }[]).map((r) => r.reverses_entry_id)
    );
    setIsCancelled(reversedIds.has(loadedBill.journal_entry_id));
    const loadedGoodsReceipt = (grn ?? null) as unknown as GoodsReceiptForBill | null;
    setGoodsReceipt(loadedGoodsReceipt);
    setLoadError(cnErr?.message ?? repErr?.message ?? null);

    // Isi form awal -- setara openReturForm() di view.tsx lama, tapi sekarang dijalankan
    // begitu data bill kelar dimuat karena halaman ini SATU-SATUNYA tujuan (bukan modal).
    const debitAccountOptions = loadedGoodsReceipt
      ? Array.from(uniqueDebitAccounts.values())
      : Array.from(uniqueDebitAccounts.values()).filter((a) => !inventoryIds.has(a.id));
    setReturCreditAccountId(debitAccountOptions[0]?.id ?? "");
    const claimed = new Map<string, number>();
    for (const cn of (cns ?? []) as unknown as CreditNoteDetail[]) {
      for (const l of cn.return_lines) {
        claimed.set(l.item_id, (claimed.get(l.item_id) ?? 0) + l.qty_returned);
      }
    }
    for (const r of (reps ?? []) as unknown as ReplacementDetail[]) {
      for (const l of r.replacement_lines) {
        claimed.set(l.item_id, (claimed.get(l.item_id) ?? 0) + l.qty_replaced);
      }
    }
    setReturLines(
      loadedGoodsReceipt
        ? loadedGoodsReceipt.goods_note_lines
            .map((l) => ({
              item_id: l.item_id,
              name: l.items.name,
              uom: l.items.uom,
              unit_cost: l.unit_cost,
              qty_available: l.qty - (claimed.get(l.item_id) ?? 0),
              qty_returned: "",
            }))
            .filter((l) => l.qty_available > 0)
        : []
    );
  }, [id]);

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
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  /**
   * Jalur financial-only (gak ada goods receipt) gak boleh nawarin akun Persediaan sebagai
   * akun kredit retur -- retur Persediaan wajib lewat qty fisik (mirror guard di
   * create_ap_credit_note, migration 0019). Jalur fisik (ada goods receipt) sebaliknya MEMANG
   * butuh akun Persediaan, jadi gak difilter.
   */
  function returCreditAccountOptions(): ResolvedAccount[] {
    return goodsReceipt ? billDebitAccounts : billDebitAccounts.filter((a) => !inventoryAccountIds.has(a.id));
  }

  function updateReturLine(itemId: string, qty: string) {
    setReturLines((prev) => prev.map((l) => (l.item_id === itemId ? { ...l, qty_returned: qty } : l)));
  }

  async function handleReturSubmit(e: FormEvent) {
    e.preventDefault();
    if (!bill) return;
    setReturError(null);

    const activeLines = returLines
      .filter((l) => l.qty_returned.trim() !== "")
      .map((l) => ({ item_id: l.item_id, qty_returned: l.qty_returned }));

    if (goodsReceipt && activeLines.length === 0) {
      setReturError("Bill ini lewat goods receipt — isi minimal 1 baris qty retur");
      return;
    }

    const estimatedAmount = returLines.reduce((sum, l) => {
      const qty = Number(l.qty_returned);
      return l.qty_returned.trim() !== "" && !Number.isNaN(qty) ? sum + qty * l.unit_cost : sum;
    }, 0);

    const parsed = createApCreditNoteSchema.safeParse({
      bill_id: bill.id,
      credit_note_date: returDate,
      amount: goodsReceipt ? estimatedAmount : returAmount,
      payable_account_id: defaultAccounts["ap.payable"]?.id ?? "",
      credit_account_id: returCreditAccountId,
      lines: activeLines,
      return_credit_asset_account_id: defaultAccounts["ap.return_credit_asset"]?.id || undefined,
    });
    if (!parsed.success) {
      setReturError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }

    setReturSubmitting(true);
    let sourceRef: string;
    try {
      sourceRef = await generateDocumentNumber("ap_credit_notes");
    } catch (err) {
      setReturSubmitting(false);
      setReturError(err instanceof Error ? err.message : "Gagal generate nomor dokumen");
      return;
    }
    const { error } = await supabase.rpc("create_ap_return", {
      p_bill_id: parsed.data.bill_id,
      p_credit_note_date: parsed.data.credit_note_date,
      p_source_ref: sourceRef,
      p_amount: parsed.data.amount,
      p_payable_account_id: parsed.data.payable_account_id,
      p_credit_account_id: parsed.data.credit_account_id,
      p_lines: parsed.data.lines.length > 0 ? parsed.data.lines : null,
      p_return_credit_asset_account_id: parsed.data.return_credit_asset_account_id ?? null,
    });
    setReturSubmitting(false);
    if (error) {
      setReturError(error.message);
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

  // Sama persis kayak estimatedAmount di handleReturSubmit -- dihitung ulang di render scope
  // biar JournalPreviewPanel bisa nunjukin jurnal "Piutang Retur Supplier" cuma pas beneran
  // bakal kejadian (retur ngelebihin outstanding), bukan asumsi selalu ada.
  const returEffectiveAmount = goodsReceipt
    ? returLines.reduce((sum, l) => {
        const qty = Number(l.qty_returned);
        return l.qty_returned.trim() !== "" && !Number.isNaN(qty) ? sum + qty * l.unit_cost : sum;
      }, 0)
    : Number(returAmount) || 0;
  const returExcess = Math.max(0, returEffectiveAmount - Math.max(0, outstanding));

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/ap-bills/${id}`} label="Kembali ke Detail Tagihan" />

      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-black">Retur — Kurangi Utang</h1>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-mono text-slate-600">
            {bill.source_ref}
          </span>
        </div>
        <p className="text-sm text-slate-500">
          {goodsReceipt
            ? "Bill ini lewat Barang Masuk — isi qty per item yang diretur, stok otomatis berkurang dan Utang Usaha dikurangi sebesar cost fisik barang (bukan angka yang kamu ketik). Kalau bill ini udah lunas, kelebihannya otomatis jadi Piutang Retur Supplier."
            : "Bill ini gak lewat Barang Masuk — retur cuma ngurangin Utang Usaha lewat nominal yang kamu isi, gak ada stok yang disentuh. Kalau bill ini udah lunas, kelebihannya otomatis jadi Piutang Retur Supplier."}
        </p>
      </div>

      {isCancelled && <FormError>Bill ini sudah dibatalkan — retur gak bisa diajukan.</FormError>}
      {!canWrite && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal ketolak RLS.
        </p>
      )}

      <form onSubmit={handleReturSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_date">Tanggal Retur</Label>
                <Input id="retur_date" type="date" value={returDate} onChange={(e) => setReturDate(e.target.value)} />
              </div>
              {!goodsReceipt && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="retur_amount">Nominal Retur (kurangin Utang Usaha)</Label>
                  <Input
                    id="retur_amount"
                    type="number"
                    min="0"
                    placeholder="0"
                    value={returAmount}
                    onChange={(e) => setReturAmount(e.target.value)}
                  />
                </div>
              )}
              <LockedAccountField
                label="Akun Utang Usaha (debit)"
                htmlFor="retur_payable_account"
                resolved={defaultAccounts["ap.payable"]}
              />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="retur_credit_account">Akun Persediaan/Beban (kredit)</Label>
                <Select
                  id="retur_credit_account"
                  value={returCreditAccountId}
                  onChange={(e) => setReturCreditAccountId(e.target.value)}
                >
                  <option value="">Pilih akun...</option>
                  {returCreditAccountOptions().map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
                {returCreditAccountOptions().length === 0 && (
                  <p className="text-xs text-amber-600">
                    {goodsReceipt
                      ? "Gak ketemu baris debit di bill ini — hubungi admin."
                      : "Bill ini cuma didebit ke akun Persediaan, tanpa Barang Masuk — retur Persediaan wajib lewat Barang Masuk (bukti fisik). Hubungi admin kalau perlu retur bill ini."}
                  </p>
                )}
                {returCreditAccountOptions().length > 1 && (
                  <p className="text-xs text-slate-500">
                    Bill ini punya {returCreditAccountOptions().length} kategori debit berbeda — pilih yang mana
                    yang diretur.
                  </p>
                )}
              </div>
              <LockedAccountField
                label="Akun Piutang Retur Supplier (debit, cuma kalau retur ini bikin Utang Usaha jadi minus)"
                htmlFor="retur_return_credit_asset_account"
                resolved={defaultAccounts["ap.return_credit_asset"]}
              />
            </div>

            {goodsReceipt && (
              <div className="mt-4 flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_8rem] gap-2 text-sm font-medium text-slate-500">
                  <span>Item Diterima (sisa bisa diklaim)</span>
                  <span>Qty Retur</span>
                </div>
                {returLines.map((line) => (
                  <div key={line.item_id} className="grid grid-cols-[1fr_8rem] gap-2">
                    <span className="flex items-center text-sm text-slate-700">
                      {line.name} ({line.qty_available} {line.uom})
                    </span>
                    <Input
                      type="number"
                      min="0"
                      max={line.qty_available}
                      placeholder="0"
                      value={line.qty_returned}
                      onChange={(e) => updateReturLine(line.item_id, e.target.value)}
                    />
                  </div>
                ))}
                {returLines.length === 0 && (
                  <p className="text-sm text-slate-400">
                    Semua item di bill ini udah diklaim penuh (retur atau tukar barang).
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <JournalPreviewPanel
            groups={[
              [
                { label: "Akun Utang Usaha (debit)", resolved: defaultAccounts["ap.payable"], side: "debit" },
                !!returCreditAccountId && {
                  label: "Akun Persediaan/Beban (kredit)",
                  resolved: returCreditAccountOptions().find((a) => a.id === returCreditAccountId),
                  side: "credit",
                },
              ],
              returExcess > 0 && [
                {
                  label: "Akun Piutang Retur Supplier (debit) — retur ini ngelebihin outstanding",
                  resolved: defaultAccounts["ap.return_credit_asset"],
                  side: "debit",
                },
                { label: "Akun Utang Usaha (kredit)", resolved: defaultAccounts["ap.payable"], side: "credit" },
              ],
            ]}
          />

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-500">Nominal Retur</p>
            <p className="mt-1 font-mono text-2xl text-black">Rp{returEffectiveAmount.toLocaleString("id-ID")}</p>
          </div>

          {returError && <FormError>{returError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={returSubmitting}>
              {returSubmitting ? "Menyimpan..." : "Simpan Retur"}
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
