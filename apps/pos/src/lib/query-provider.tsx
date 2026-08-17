"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// QueryClient dibuat sekali per browser tab lewat useState (bukan module-level
// singleton) -- pola standar Next.js App Router, hindari state kebagi lintas request
// di server meski app POS ini "use client" semua (tetap aman kalau nanti ada SSR).
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
          },
        },
      })
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
