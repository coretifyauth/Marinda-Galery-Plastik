"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { ItemBrand } from "@/lib/item-brands/schema";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-message";
import { BackLink } from "@/components/ui/back-link";
import { DetailRows } from "@/components/ui/detail-rows";

type MemberItem = { id: string; name: string; item_type: string; uom: string; archived_at: string | null };

export function ItemBrandDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);
  const [brand, setBrand] = useState<ItemBrand | null>(null);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const load = useCallback(async () => {
    const [{ data: br, error: brErr }, { data: items }] = await Promise.all([
      supabase.from("item_brands").select("id, name, archived_at").eq("id", id).single(),
      supabase
        .from("items")
        .select("id, name, item_type, uom, archived_at")
        .eq("brand_id", id)
        .order("name"),
    ]);
    if (brErr || !br) {
      setLoadError(brErr?.message ?? "Brand gak ditemukan.");
      return;
    }
    setLoadError(null);
    setBrand(br as ItemBrand);
    setMembers((items ?? []) as MemberItem[]);
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

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  if (!brand) {
    return <FormError>{loadError ?? "Brand gak ditemukan."}</FormError>;
  }

  const canWrite = roles.includes("admin");

  async function handleArchive() {
    if (!brand) return;
    setActionError(null);
    setProcessing(true);
    const { error } = await supabase
      .from("item_brands")
      .update({ archived_at: brand.archived_at ? null : new Date().toISOString() })
      .eq("id", brand.id);
    setProcessing(false);
    if (error) {
      setActionError(error.message);
      return;
    }
    await load();
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <BackLink href="/items" label="Kembali ke Items" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-black">Brand: {brand.name}</h1>
        {canWrite && (
          <Button variant="toolbar" onClick={handleArchive} disabled={processing}>
            {processing ? "Memproses..." : brand.archived_at ? "Aktifkan" : "Nonaktifkan"}
          </Button>
        )}
      </div>

      {loadError && <FormError>{loadError}</FormError>}
      {actionError && <FormError>{actionError}</FormError>}

      <DetailRows
        groups={[
          {
            title: "Informasi Brand",
            rows: [
              { label: "Nama", value: brand.name },
              { label: "Status", value: brand.archived_at ? "Dinonaktifkan" : "Aktif" },
              { label: "Jumlah Barang", value: String(members.length) },
            ],
          },
        ]}
      />

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2">
          <span className="text-sm font-medium text-black">Barang dengan Brand Ini</span>
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{members.length}</span>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <th className="px-4 py-2">Nama</th>
              <th className="px-4 py-2">Tipe</th>
              <th className="px-4 py-2">Satuan Dasar</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((item) => (
              <tr
                key={item.id}
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                onClick={() => router.push(`/items/${item.id}`)}
              >
                <td className="px-4 py-2">{item.name}</td>
                <td className="px-4 py-2">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {item.item_type}
                  </span>
                </td>
                <td className="px-4 py-2">{item.uom}</td>
                <td className="px-4 py-2">
                  {item.archived_at ? (
                    <span className="text-xs text-slate-400">Diarsipkan</span>
                  ) : (
                    <span className="text-xs text-emerald-600">Aktif</span>
                  )}
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Belum ada barang dengan brand ini.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
