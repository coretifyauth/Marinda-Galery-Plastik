"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { LoadingScreen } from "@/components/ui/loading-screen";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      router.replace(session ? "/accounts" : "/login");
    });
  }, [router]);

  return <LoadingScreen />;
}
