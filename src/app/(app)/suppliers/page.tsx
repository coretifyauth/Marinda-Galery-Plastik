"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { createSupplierSchema, type Supplier } from "@/lib/suppliers/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";

export default function SuppliersPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [paymentTermDays, setPaymentTermDays] = useState("14");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const loadSuppliers = useCallback(async () => {
    const { data, error } = await supabase
      .from("suppliers")
      .select("id, name, contact, payment_term_days, archived_at")
      .order("name");
    if (error) {
      setLoadError(error.message);
      return;
    }
    setLoadError(null);
    setSuppliers((data ?? []) as Supplier[]);
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
      await loadSuppliers();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, loadSuppliers]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = createSupplierSchema.safeParse({
      name,
      contact: contact || undefined,
      payment_term_days: paymentTermDays,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from("suppliers").insert(parsed.data);
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    setName("");
    setContact("");
    setPaymentTermDays("14");
    setShowForm(false);
    await loadSuppliers();
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full max-w-3xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Suppliers — CV Roti Barokah</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {loadError && <FormError>{loadError}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Suppliers</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {suppliers.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => loadSuppliers()}>
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
              <th className="px-4 py-2">Nama</th>
              <th className="px-4 py-2">Kontak</th>
              <th className="px-4 py-2">Termin (hari)</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 font-medium text-black">{s.name}</td>
                <td className="px-4 py-2">{s.contact ?? "-"}</td>
                <td className="px-4 py-2">{s.payment_term_days}</td>
              </tr>
            ))}
            {suppliers.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-400">
                  Belum ada supplier.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold text-black">Tambah Supplier</h2>
          {!canWrite && (
            <p className="mb-4 text-sm text-amber-600">
              Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
              ketolak RLS.
            </p>
          )}
          <form onSubmit={handleCreate} className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Nama</Label>
              <Input
                id="name"
                placeholder="mis. Toko Gula Sejahtera"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="contact">Kontak</Label>
              <Input
                id="contact"
                placeholder="mis. 022-xxxx-1002"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment_term_days">Termin (hari)</Label>
              <Input
                id="payment_term_days"
                type="number"
                min="1"
                value={paymentTermDays}
                onChange={(e) => setPaymentTermDays(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Menyimpan..." : "Simpan"}
            </Button>
          </form>
          {formError && (
            <div className="mt-3">
              <FormError>{formError}</FormError>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
