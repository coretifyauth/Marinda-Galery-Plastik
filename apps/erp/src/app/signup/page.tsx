"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpenCheck, Boxes, Lock, Mail, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { hasErpAccess } from "@/lib/app-access";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";

const highlights = [
  { icon: BookOpenCheck, text: "Pembukuan double-entry yang selalu balance" },
  { icon: Boxes, text: "Stok & harga jual multi-satuan dalam satu tempat" },
  { icon: ShieldCheck, text: "Jejak audit lengkap untuk tiap transaksi" },
];

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (data.session) {
      const allowed = await hasErpAccess(data.user!.id);
      if (!allowed) {
        await supabase.auth.signOut();
        setMessage("Akun kasir berhasil dibuat -- login-nya lewat aplikasi POS, bukan di sini.");
        return;
      }
      router.push("/accounts");
      return;
    }
    setMessage(
      "Akun dibuat. Kalau project ini masih minta konfirmasi email, cek inbox dulu sebelum login. Kalau tidak, langsung bisa login."
    );
  }

  return (
    <div className="grid min-h-screen w-full flex-1 bg-white lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-blue-600 p-10 text-white lg:flex">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.16),transparent_55%)]" />
        <div className="relative flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-sm font-bold">
            CE
          </span>
          <span className="text-lg font-semibold">Custom ERP</span>
        </div>
        <div className="relative flex flex-col gap-7">
          <h2 className="text-5xl font-semibold leading-tight">
            Mulai kelola akuntansi dan operasional bisnis kamu hari ini.
          </h2>
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
            <span className="font-semibold text-black">Custom ERP</span>
          </div>

          <h1 className="text-2xl font-semibold text-black">Buat akun baru</h1>
          <p className="mt-1 text-sm text-slate-500">
            Registrasi cuma bisa dipakai email yang sudah diundang -- hubungi admin kalau email
            kamu belum bisa daftar.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
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
              <Label htmlFor="password">Kata Sandi</Label>
              <div className="relative flex items-center rounded-lg border border-slate-200 bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/40">
                <Lock className="ml-3 h-4 w-4 shrink-0 text-slate-400" />
                <input
                  id="password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full border-0 bg-transparent px-2.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
                />
              </div>
              <FormHint>Minimal 6 karakter.</FormHint>
            </div>
            {error && <FormError>{error}</FormError>}
            {message && <p className="text-sm text-emerald-600">{message}</p>}
            <Button type="submit" disabled={loading} className="mt-2 flex items-center justify-center gap-2">
              {loading ? (
                "Memproses..."
              ) : (
                <>
                  Daftar <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Sudah punya akun?{" "}
            <Link href="/login" className="font-medium text-blue-600 hover:text-blue-700">
              Masuk
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
