/** Deteksi online/offline buat POS. Dua lapis sengaja dipisah:
 * - useOnlineStatus() -- sinyal murah buat badge UI (navigator.onLine + event
 *   online/offline), TIDAK dipakai buat mutusin apakah boleh nembak Supabase.
 * - probeSupabase() -- ping asli ke server, ini yang jadi gerbang keputusan nyata
 *   di checkoutMutation & offline-sync.ts, karena navigator.onLine cuma nunjukin
 *   status adapter jaringan, bukan bukti server beneran bisa dijangkau. */
"use client";

import { useCallback, useEffect, useState } from "react";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

// Sengaja pakai fetch() mentah ke endpoint Supabase, BUKAN lewat supabase-js query
// builder -- ketemu bug nyata: query lewat client (GET) bisa kejawab dari HTTP cache
// WebView2 walau internet mati, jadi probe selalu balik "online". fetch() manual +
// cache: "no-store" + query param cache-busting mastiin request ini SELALU beneran
// nembus jaringan, gak pernah kejawab dari cache. Respons APAPUN (termasuk 401/404)
// dianggap "online" -- yang penting server ke-reach, bukan soal auth/routenya valid.
export async function probeSupabase(timeoutMs = 2500): Promise<boolean> {
  if (!SUPABASE_URL) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/health?_=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function isLikelyNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // "Failed to fetch" dkk
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch|network|abort|timeout|ERR_/i.test(msg);
}

const POLL_INTERVAL_MS = 10_000;

export function useOnlineStatus(): { isOnline: boolean; checkNow: () => Promise<boolean> } {
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  const checkNow = useCallback(async () => {
    const ok = await probeSupabase();
    setIsOnline(ok);
    return ok;
  }, []);

  useEffect(() => {
    // Event browser (online/offline) TERBUKTI gak reliable di WebView2 Tauri --
    // dipakai cuma buat reaksi cepat kalau kebetulan kepicu, TIDAK dipercaya sendirian.
    // Sumber kebenaran sebenarnya: probe aktif tiap 10 detik + langsung pas mount,
    // biar badge selalu mencerminkan kondisi nyata, bukan cuma status adapter jaringan.
    // setIsOnline sengaja dipanggil di dalam .then() (bukan langsung di body efek)
    // biar gak kena "setState sinkron dalam efek".
    let cancelled = false;
    function poll() {
      probeSupabase().then((ok) => {
        if (!cancelled) setIsOnline(ok);
      });
    }
    window.addEventListener("online", poll);
    window.addEventListener("offline", poll);
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("online", poll);
      window.removeEventListener("offline", poll);
      clearInterval(interval);
    };
  }, []);

  return { isOnline, checkNow };
}
