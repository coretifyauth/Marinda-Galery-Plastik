"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { createCustomerSchema, type CreateCustomerInput } from "@/lib/customers/schema";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, useCustomers } from "@/lib/customers/queries";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";

// Input kecil buat baris filter di header tabel -- pola sama journal-entries/page.tsx.
const compactFilterInputClass =
  "w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600/40";

export default function CustomersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [checkingSession, setCheckingSession] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);

  const [nameSearchInput, setNameSearchInput] = useState("");
  const [contactSearchInput, setContactSearchInput] = useState("");
  const [archivedFilter, setArchivedFilter] = useState<"" | "active" | "archived">("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const debouncedNameSearch = useDebouncedValue(nameSearchInput, 300);
  const debouncedContactSearch = useDebouncedValue(contactSearchInput, 300);

  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [paymentTermDays, setPaymentTermDays] = useState("7");
  const [creditLimit, setCreditLimit] = useState("");
  const [overdueThresholdDays, setOverdueThresholdDays] = useState("7");
  const [overdueThresholdTouched, setOverdueThresholdTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Filter berubah -> balik ke halaman 1 (pola "adjust state during render", lihat
  // journal-entries/page.tsx -- BUKAN useEffect, biar gak kena lint react-hooks/set-state-in-effect).
  const filterKey = `${debouncedNameSearch}|${debouncedContactSearch}|${archivedFilter}|${pageSize}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(0);
  }

  const filters = {
    nameSearch: debouncedNameSearch,
    contactSearch: debouncedContactSearch,
    archivedFilter,
    page,
    pageSize,
  };
  const customersQuery = useCustomers(filters);
  const customers = customersQuery.data?.rows ?? [];
  const total = customersQuery.data?.total ?? 0;

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
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateCustomerInput) => {
      const { error } = await supabase.from("customers").insert(input);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setName("");
      setContact("");
      setPaymentTermDays("7");
      setCreditLimit("");
      setOverdueThresholdDays("7");
      setOverdueThresholdTouched(false);
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Gagal menyimpan customer");
    },
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = createCustomerSchema.safeParse({
      name,
      contact: contact || undefined,
      payment_term_days: paymentTermDays,
      credit_limit: creditLimit || undefined,
      overdue_threshold_days: overdueThresholdDays || undefined,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Input gak valid");
      return;
    }
    createMutation.mutate(parsed.data);
  }

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  const canWrite = roles.includes("admin") || roles.includes("accountant");

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Customers</h1>
        <p className="text-sm text-slate-500">
          Role kamu:{" "}
          {roles.length > 0 ? roles.join(", ") : "belum ada role — cuma bisa lihat"}
        </p>
      </div>

      {customersQuery.error && <FormError>{(customersQuery.error as Error).message}</FormError>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-black">Customers</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="toolbar" onClick={() => customersQuery.refetch()}>
              Refresh
            </Button>
            {canWrite && (
              <Button variant="toolbar-primary" onClick={() => setShowForm(true)}>
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
              <th className="px-4 py-2">Credit Limit</th>
              <th className="px-4 py-2">Toleransi Telat (hari)</th>
              <th className="px-4 py-2">Status</th>
            </tr>
            <tr className="border-b border-slate-200 bg-slate-50/50">
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari nama..."
                  value={nameSearchInput}
                  onChange={(e) => setNameSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5">
                <input
                  type="text"
                  placeholder="Cari kontak..."
                  value={contactSearchInput}
                  onChange={(e) => setContactSearchInput(e.target.value)}
                  className={compactFilterInputClass}
                />
              </th>
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5" />
              <th className="px-4 py-1.5">
                <select
                  aria-label="Filter status"
                  value={archivedFilter}
                  onChange={(e) => setArchivedFilter(e.target.value as "" | "active" | "archived")}
                  className={compactFilterInputClass}
                >
                  <option value="">Semua Status</option>
                  <option value="active">Aktif</option>
                  <option value="archived">Diarsipkan</option>
                </select>
              </th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                onClick={() => router.push(`/customers/${c.id}`)}
              >
                <td className="px-4 py-2 font-medium text-black">{c.name}</td>
                <td className="px-4 py-2">{c.contact ?? "-"}</td>
                <td className="px-4 py-2">{c.payment_term_days}</td>
                <td className="px-4 py-2">
                  {c.credit_limit != null ? c.credit_limit.toLocaleString("id-ID") : "Tanpa batas"}
                </td>
                <td className="px-4 py-2">{c.overdue_threshold_days ?? "Tanpa batas"}</td>
                <td className="px-4 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      c.archived_at ? "bg-slate-100 text-slate-600" : "bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    {c.archived_at ? "Diarsipkan" : "Aktif"}
                  </span>
                </td>
              </tr>
            ))}
            {customers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  {customersQuery.isLoading ? "Memuat..." : "Belum ada customer."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageSizeChange={setPageSize}
        />
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Tambah Customer">
        {!canWrite && (
          <p className="mb-4 text-sm text-amber-600">
            Kamu belum punya role admin/accountant — submit di bawah kemungkinan bakal
            ketolak RLS.
          </p>
        )}
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Nama</Label>
            <Input
              id="name"
              placeholder="mis. Warung Bu Imas"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contact">Kontak</Label>
            <Input
              id="contact"
              placeholder="mis. 0812-xxxx-0002"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment_term_days">Termin (hari)</Label>
              <Input
                id="payment_term_days"
                type="number"
                min="1"
                value={paymentTermDays}
                onChange={(e) => {
                  setPaymentTermDays(e.target.value);
                  if (!overdueThresholdTouched) setOverdueThresholdDays(e.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="overdue_threshold_days">Toleransi Telat (hari)</Label>
              <Input
                id="overdue_threshold_days"
                type="number"
                min="1"
                value={overdueThresholdDays}
                onChange={(e) => {
                  setOverdueThresholdTouched(true);
                  setOverdueThresholdDays(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credit_limit">Credit Limit (kosongkan = tanpa batas)</Label>
            <Input
              id="credit_limit"
              type="number"
              min="0"
              placeholder="mis. 1000000"
              value={creditLimit}
              onChange={(e) => setCreditLimit(e.target.value)}
            />
          </div>
          {formError && <FormError>{formError}</FormError>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Menyimpan..." : "Simpan"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
