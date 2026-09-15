"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { LoadingScreen } from "@/components/ui/loading-screen";

// Setup Awal -- ref docs/domain/chart-of-accounts.md submodule "Onboarding / Setup Awal",
// docs/architecture/coa-schema.md submodule "Onboarding -- Bootstrap Konfigurasi Awal".
// 2 langkah, 2 RPC terpisah (bukan 1 form besar): langkah 1 nampilin daftar peran akun
// wajib sebagai tabel (mirip halaman Pengaturan > Default Akun), 1 tombol nge-generate
// semuanya; langkah 2 (identitas usaha + pajak) baru aktif setelah langkah 1 selesai.

// Daftar peran akun wajib -- persis 19 role_key di RPC bootstrap_default_accounts
// (supabase/migrations/0033_onboarding_bootstrap.sql). Duplikasi label di sini SENGAJA
// (bukan di-fetch) -- sebelum langkah 1 dijalankan, app_default_account_settings masih
// kosong, gak ada tempat lain buat baca daftar "apa yang BAKAL dibuat".
const DEFAULT_ACCOUNT_ROLES = [
  { roleKey: "ar.receivable", label: "Piutang Usaha" },
  { roleKey: "ar.revenue", label: "Pendapatan Penjualan Grosir" },
  { roleKey: "ar.contra_revenue", label: "Retur & Potongan Penjualan" },
  { roleKey: "ar.deposit_liability", label: "Uang Muka Penjualan" },
  { roleKey: "ar.writeoff_expense", label: "Beban Piutang Tak Tertagih" },
  { roleKey: "ar.return_credit_liability", label: "Saldo Kredit Retur Customer" },
  { roleKey: "ar.other_revenue", label: "Pendapatan Lain-lain" },
  { roleKey: "ap.payable", label: "Utang Usaha" },
  { roleKey: "ap.return_credit_asset", label: "Piutang Retur Supplier" },
  { roleKey: "ap.deposit_asset", label: "Uang Muka Pembelian" },
  { roleKey: "ap.deposit_loss_expense", label: "Beban Kerugian Uang Muka" },
  { roleKey: "inventory.raw_material", label: "Persediaan Bahan Baku" },
  { roleKey: "inventory.finished_good", label: "Persediaan Barang Jadi" },
  { roleKey: "inventory.hpp", label: "Harga Pokok Penjualan" },
  { roleKey: "inventory.damage_loss_expense", label: "Beban Kerugian Barang Rusak" },
  { roleKey: "inventory.shortage_expense", label: "Beban Selisih Persediaan" },
  { roleKey: "inventory.surplus_revenue", label: "Pendapatan Selisih Persediaan" },
  { roleKey: "cash.tunai", label: "Kas Toko" },
  { roleKey: "cash.bank", label: "Kas di Bank" },
] as const;

type ResolvedRow = { roleKey: string; label: string; code: string | null; name: string | null };

export default function SetupPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [step1Done, setStep1Done] = useState(false);
  const [resolvedRows, setResolvedRows] = useState<ResolvedRow[]>(
    DEFAULT_ACCOUNT_ROLES.map((r) => ({ roleKey: r.roleKey, label: r.label, code: null, name: null }))
  );
  const [step1Submitting, setStep1Submitting] = useState(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  const [companyName, setCompanyName] = useState("");
  const [companyAddress, setCompanyAddress] = useState("");
  const [npwp, setNpwp] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [ppnActive, setPpnActive] = useState(false);
  const [ppnRate, setPpnRate] = useState("11");
  const [step2Error, setStep2Error] = useState<string | null>(null);
  const [step2Submitting, setStep2Submitting] = useState(false);

  const loadResolved = useCallback(async () => {
    const { data } = await supabase
      .from("app_default_account_settings")
      .select("role_key, accounts(code, name)");
    const rows = (data ?? []) as unknown as {
      role_key: string;
      accounts: { code: string; name: string } | null;
    }[];
    if (rows.length === 0) {
      setStep1Done(false);
      return;
    }
    const byRoleKey = new Map(rows.map((r) => [r.role_key, r.accounts]));
    setResolvedRows(
      DEFAULT_ACCOUNT_ROLES.map((r) => ({
        roleKey: r.roleKey,
        label: r.label,
        code: byRoleKey.get(r.roleKey)?.code ?? null,
        name: byRoleKey.get(r.roleKey)?.name ?? null,
      }))
    );
    setStep1Done(true);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      await loadResolved();
      if (active) setChecking(false);
    })();
    return () => {
      active = false;
    };
  }, [loadResolved]);

  async function handleStep1() {
    setStep1Error(null);
    setStep1Submitting(true);
    const { error } = await supabase.rpc("bootstrap_default_accounts");
    setStep1Submitting(false);
    if (error) {
      setStep1Error(error.message);
      return;
    }
    await loadResolved();
  }

  async function handleStep2(e: FormEvent) {
    e.preventDefault();
    setStep2Error(null);

    if (!companyName.trim()) {
      setStep2Error("Nama usaha wajib diisi");
      return;
    }
    const rate = Number(ppnRate);
    if (ppnActive && (Number.isNaN(rate) || rate <= 0)) {
      setStep2Error("Tarif PPN harus angka lebih dari 0");
      return;
    }

    setStep2Submitting(true);
    const { error } = await supabase.rpc("complete_onboarding", {
      p_company_name: companyName.trim(),
      p_company_address: companyAddress.trim() || null,
      p_npwp: npwp.trim() || null,
      p_logo_url: logoUrl.trim() || null,
      p_ppn_active: ppnActive,
      p_ppn_rate: rate,
    });
    setStep2Submitting(false);

    if (error) {
      setStep2Error(error.message);
      return;
    }

    router.replace("/");
    router.refresh();
  }

  if (checking) {
    return <LoadingScreen />;
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-black">Setup Awal</h1>
        <p className="text-sm text-slate-500">
          Aplikasi belum punya konfigurasi wajib (Chart of Accounts, Default Akun, dst) — selesaikan
          langkah ini sekali sebelum mulai bertransaksi.
        </p>
      </div>

      <div className="mb-6 rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Langkah 1</p>
            <p className="text-sm font-medium text-slate-900">Akun & Konfigurasi Bawaan</p>
          </div>
          {step1Done && (
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
              ✓ Diterapkan
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
                <th className="py-2 pl-6 pr-4">Peran Akun</th>
                <th className="py-2 pr-6">Akun</th>
              </tr>
            </thead>
            <tbody>
              {resolvedRows.map((r) => (
                <tr key={r.roleKey} className="border-b border-slate-100 text-sm">
                  <td className="py-2 pl-6 pr-4 text-slate-700">{r.label}</td>
                  <td className="py-2 pr-6 font-mono text-slate-600">
                    {r.code ? (
                      `${r.code} — ${r.name}`
                    ) : (
                      <span className="font-sans italic text-slate-400">akan dibuat otomatis</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 px-6 py-4">
          <p className="text-xs text-slate-500">
            Plus 29 jenis nomor dokumen otomatis (AR Invoice, AP Bill, Purchase Order, dst).
          </p>
          {step1Error && <FormError>{step1Error}</FormError>}
          {!step1Done && (
            <Button onClick={handleStep1} disabled={step1Submitting} className="self-start">
              {step1Submitting ? "Menerapkan..." : "Terapkan Akun Bawaan"}
            </Button>
          )}
        </div>
      </div>

      <form
        onSubmit={handleStep2}
        className={`flex flex-col gap-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm ${
          step1Done ? "" : "pointer-events-none opacity-50"
        }`}
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Langkah 2</p>
          <p className="text-sm font-medium text-slate-900">Identitas Usaha & Pajak</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="companyName">Nama Usaha</Label>
          <Input
            id="companyName"
            placeholder="mis. Toko Maju Jaya"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            disabled={!step1Done}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="companyAddress">Alamat</Label>
          <Input
            id="companyAddress"
            value={companyAddress}
            onChange={(e) => setCompanyAddress(e.target.value)}
            disabled={!step1Done}
          />
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="npwp">NPWP</Label>
            <Input id="npwp" value={npwp} onChange={(e) => setNpwp(e.target.value)} disabled={!step1Done} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="logoUrl">URL Logo</Label>
            <Input
              id="logoUrl"
              placeholder="https://..."
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              disabled={!step1Done}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={ppnActive}
              onChange={(e) => setPpnActive(e.target.checked)}
              disabled={!step1Done}
            />
            Usaha ini wajib pungut PPN
          </label>
          {ppnActive && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ppnRate">Tarif PPN (%)</Label>
              <Input
                id="ppnRate"
                type="number"
                step="0.01"
                value={ppnRate}
                onChange={(e) => setPpnRate(e.target.value)}
                disabled={!step1Done}
              />
            </div>
          )}
        </div>

        {step2Error && <FormError>{step2Error}</FormError>}

        <Button type="submit" disabled={!step1Done || step2Submitting}>
          {step2Submitting ? "Menyimpan..." : "Selesaikan Setup"}
        </Button>
      </form>
    </div>
  );
}
