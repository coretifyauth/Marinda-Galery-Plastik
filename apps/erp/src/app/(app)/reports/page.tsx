"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Scale, TrendingUp, Landmark, Waves, Lock } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

const reports = [
  {
    href: "/reports/trial-balance",
    label: "Trial Balance",
    description: "Saldo semua akun di 1 titik waktu — fondasi 3 laporan lain.",
    icon: Scale,
  },
  {
    href: "/reports/income-statement",
    label: "Income Statement",
    description: "Laba Rugi untuk 1 rentang tanggal — Pendapatan dikurangi Beban.",
    icon: TrendingUp,
  },
  {
    href: "/reports/balance-sheet",
    label: "Balance Sheet",
    description: "Neraca per 1 tanggal — Aset = Liabilitas + Ekuitas.",
    icon: Landmark,
  },
  {
    href: "/reports/cash-flow",
    label: "Cash Flow",
    description: "Pergerakan kas fisik (Indirect Method) untuk 1 rentang tanggal.",
    icon: Waves,
  },
  {
    href: "/reports/period-closing",
    label: "Tutup Buku",
    description: "Nol-in Pendapatan/Beban ke Laba Ditahan, kunci periode dari transaksi baru.",
    icon: Lock,
  },
];

export default function ReportsPage() {
  const router = useRouter();
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      if (!session) {
        router.replace("/login");
        return;
      }
      setCheckingSession(false);
    });
    return () => {
      active = false;
    };
  }, [router]);

  if (checkingSession) {
    return <p className="text-sm text-slate-500">Memuat...</p>;
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Financial Reports</h1>
        <p className="text-sm text-slate-500">
          4 laporan pertama murni agregasi read-only. Tutup Buku beda — itu tindakan menulis
          (nol-in Pendapatan/Beban, kunci periode dari transaksi baru).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {reports.map(({ href, label, description, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:border-slate-300 hover:shadow"
          >
            <Icon className="h-5 w-5 text-blue-600" />
            <span className="font-semibold text-black">{label}</span>
            <span className="text-sm text-slate-500">{description}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
