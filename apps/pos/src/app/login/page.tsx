"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Lock, Mail, Receipt, RefreshCw, ScanLine } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { hasPosAccess } from "@/lib/app-access";

const highlights = [
  { icon: ScanLine, text: "Scan barcode, checkout dalam hitungan detik" },
  { icon: RefreshCw, text: "Stok real-time, sinkron langsung ke ERP" },
  { icon: Receipt, text: "Cetak struk & kelola pembayaran dalam 1 layar" },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      setError(error.message);
      return;
    }
    const allowed = await hasPosAccess(data.user.id);
    setLoading(false);
    if (!allowed) {
      await supabase.auth.signOut();
      setError("Akun ini gak punya akses ke POS -- kalau ini akun admin/ERP, masuk lewat aplikasi ERP.");
      return;
    }
    router.push("/");
  }

  return (
    <div className="grid min-h-screen w-full flex-1 bg-white lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-blue-600 p-10 text-white lg:flex">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.16),transparent_55%)]" />
        <div className="relative flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-sm font-bold">
            KS
          </span>
          <span className="text-lg font-semibold">Kasir POS</span>
        </div>
        <div className="relative flex flex-col gap-7">
          <h2 className="text-5xl font-semibold leading-tight">Checkout cepat, stok selalu akurat.</h2>
          <ul className="flex flex-col gap-4">
            {highlights.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-blue-50">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15">
                  <Icon className="h-4 w-4" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-blue-100">© {new Date().getFullYear()} Custom ERP</p>
      </div>

      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-600" />
            <span className="font-semibold text-black">Kasir POS</span>
          </div>

          <h1 className="text-2xl font-semibold text-black">Masuk Kasir</h1>
          <p className="mt-1 text-sm text-slate-500">Checkout dan kelola transaksi harian di kios kamu.</p>

          <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-sm font-medium text-slate-700">
                Email
              </label>
              <div className="relative flex items-center rounded-lg border border-slate-200 bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/40">
                <Mail className="ml-3 h-4 w-4 shrink-0 text-slate-400" />
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nama@perusahaan.com"
                  className="w-full border-0 bg-transparent px-2.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium text-slate-700">
                Kata Sandi
              </label>
              <div className="relative flex items-center rounded-lg border border-slate-200 bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/40">
                <Lock className="ml-3 h-4 w-4 shrink-0 text-slate-400" />
                <input
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full border-0 bg-transparent px-2.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
                />
              </div>
            </div>
            {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-blue-600 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? (
                "Memproses..."
              ) : (
                <>
                  Masuk <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Belum punya akun?{" "}
            <Link href="/signup" className="font-medium text-blue-600 hover:text-blue-700">
              Daftar sekarang
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
