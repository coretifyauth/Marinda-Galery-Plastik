"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormError, FormHint } from "@/components/ui/form-message";

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
      router.push("/accounts");
      return;
    }
    setMessage(
      "Akun dibuat. Kalau project ini masih minta konfirmasi email, cek inbox dulu sebelum login. Kalau tidak, langsung bisa login."
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-slate-100">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-slate-200 bg-white p-8 shadow-sm"
      >
        <h1 className="text-xl font-semibold text-black">Daftar Akun — CV Roti Barokah</h1>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <FormHint>Minimal 6 karakter.</FormHint>
        </div>
        {error && <FormError>{error}</FormError>}
        {message && <p className="text-sm text-emerald-600">{message}</p>}
        <Button type="submit" disabled={loading}>
          {loading ? "Memproses..." : "Daftar"}
        </Button>
        <p className="text-sm text-slate-500">
          Sudah punya akun?{" "}
          <Link href="/login" className="font-medium text-amber-600 underline">
            Masuk
          </Link>
        </p>
      </form>
    </div>
  );
}
