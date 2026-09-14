"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { createCustomerSchema, type CreateCustomerInput } from "@/lib/customers/schema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function NewCustomerPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);

  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [paymentTermDays, setPaymentTermDays] = useState("7");
  const [formError, setFormError] = useState<string | null>(null);

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
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateCustomerInput) => {
      // customers -> counterparties (Fase 1 order-generalization) -- create_counterparty
      // bikin baris counterparties + counterparty_type_mapping(role='customer') dalam 1
      // transaksi, gak ada window baris "yatim" tanpa role.
      const { data, error } = await supabase.rpc("create_counterparty", {
        p_name: input.name,
        p_role: "customer",
        p_contact: input.contact ?? null,
        p_payment_term_days: input.payment_term_days,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: (newId) => {
      router.push(`/customers/${newId}`);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan pelanggan");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = createCustomerSchema.safeParse({
      name,
      contact: contact || undefined,
      payment_term_days: paymentTermDays,
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
      <BackLink href="/customers" label="Kembali ke Pelanggan" />

      <div>
        <h1 className="text-xl font-semibold text-black">Tambah Pelanggan</h1>
        <p className="text-sm text-slate-500">
          Data pelanggan baru buat transaksi kredit — dipakai di Sales Order, Invoice, dan Uang Muka AR.
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
                <Label htmlFor="name">Nama</Label>
                <Input
                  id="name"
                  autoFocus
                  placeholder="mis. Warung Bu Imas"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="contact">Kontak</Label>
                  <Input
                    id="contact"
                    placeholder="mis. 0812-xxxx-0002"
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                  />
                  <p className="text-xs text-slate-400">Opsional — nomor HP/WA atau alamat.</p>
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

          {formError && <FormError>{formError}</FormError>}

          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan Pelanggan"}
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
