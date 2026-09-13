"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { createCustomerSchema, type Customer } from "@/lib/customers/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function EditCustomerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editName, setEditName] = useState("");
  const [editContact, setEditContact] = useState("");
  const [editPaymentTermDays, setEditPaymentTermDays] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data: cust, error: custErr } = await supabase
      .from("counterparties")
      .select("id, name, contact, payment_term_days, archived_at")
      .eq("id", id)
      .single();
    if (custErr) {
      setLoadError(custErr.message);
      return;
    }
    setLoadError(null);
    const c = cust as Customer;
    setCustomer(c);
    setEditName(c.name);
    setEditContact(c.contact ?? "");
    setEditPaymentTermDays(String(c.payment_term_days));
  }, [id]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace("/login");
        return;
      }
      await load();
      if (active) setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router, load]);

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    setEditError(null);
    const parsed = createCustomerSchema.safeParse({
      name: editName,
      contact: editContact || undefined,
      payment_term_days: editPaymentTermDays,
    });
    if (!parsed.success) {
      setEditError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("counterparties")
      .update({
        name: parsed.data.name,
        contact: parsed.data.contact ?? null,
        payment_term_days: parsed.data.payment_term_days,
      })
      .eq("id", id);
    setSaving(false);
    if (error) {
      setEditError(error.message);
      return;
    }
    router.push(`/customers/${id}`);
  }

  if (checkingSession) {
    return <LoadingScreen />;
  }

  if (!customer) {
    return <FormError>{loadError ?? "Pelanggan gak ditemukan."}</FormError>;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href={`/customers/${id}`} label="Kembali ke Detail Pelanggan" />

      <div>
        <h1 className="text-xl font-semibold text-black">Ubah Pelanggan</h1>
        <p className="text-sm text-slate-500">Ubah data pelanggan {customer.name}.</p>
      </div>

      <form onSubmit={handleSaveEdit} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit_name">Nama</Label>
                <Input id="edit_name" autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="edit_contact">Kontak</Label>
                  <Input id="edit_contact" value={editContact} onChange={(e) => setEditContact(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="edit_payment_term_days">Termin (hari)</Label>
                  <Input
                    id="edit_payment_term_days"
                    type="number"
                    min="1"
                    value={editPaymentTermDays}
                    onChange={(e) => setEditPaymentTermDays(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Soal Termin Pembayaran
            </p>
            <p className="text-sm text-slate-600">
              Jatuh tempo tiap invoice baru = tanggal invoice + termin ini, dihitung sekali saat invoice
              dibuat. Mengubah termin di sini cuma berlaku ke invoice berikutnya — invoice lama yang jatuh
              temponya udah ditetapkan gak ikut geser.
            </p>
          </div>

          {editError && <FormError>{editError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Menyimpan..." : "Simpan"}
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
