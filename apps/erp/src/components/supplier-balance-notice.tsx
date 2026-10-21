"use client";

import Link from "next/link";
import { useSupplierBalances } from "@/lib/supplier-balances/queries";

const rupiah = (n: number) => `Rp${n.toLocaleString("id-ID")}`;

// Pengingat di form tagihan baru: supplier ini masih punya uang kita yang nyangkut (uang muka /
// kelebihan retur). Murni informasi — penerapan uang muka tetap lewat tombol di detail tagihan.
export function SupplierBalanceNotice({ supplierId }: { supplierId: string }) {
  const { data } = useSupplierBalances(supplierId);
  if (!supplierId || !data || data.rows.length === 0) return null;

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
      <p className="font-medium">
        Supplier ini punya saldo {rupiah(data.uangMukaTotal + data.kelebihanReturTotal)} di kita.
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {data.uangMukaTotal > 0 && (
          <li>
            Uang muka {rupiah(data.uangMukaTotal)} — bisa dipotongkan ke tagihan setelah tagihan ini dibuat
            (tombol <span className="font-medium">Terapkan Uang Muka</span> di detail tagihan).
          </li>
        )}
        {data.kelebihanReturTotal > 0 && (
          <li>
            Kelebihan retur {rupiah(data.kelebihanReturTotal)} — saat ini hanya bisa diminta kembali tunai, belum bisa
            memotong tagihan.
          </li>
        )}
      </ul>
      <Link href={`/suppliers/${supplierId}`} className="mt-1 inline-block text-blue-700 underline">
        Lihat rincian saldo
      </Link>
    </div>
  );
}
