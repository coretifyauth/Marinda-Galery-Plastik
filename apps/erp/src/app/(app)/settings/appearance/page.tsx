"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { setTheme, useTheme, type Theme } from "@/lib/theme";
import { FormHint } from "@/components/ui/form-message";

const OPTIONS: { key: Theme; label: string; hint: string; icon: typeof Sun }[] = [
  { key: "light", label: "Terang", hint: "Tampilan standar", icon: Sun },
  { key: "dark", label: "Gelap", hint: "Lebih nyaman di ruangan redup", icon: Moon },
  { key: "system", label: "Ikuti sistem", hint: "Mengikuti pengaturan perangkat", icon: Monitor },
];

export default function AppearanceSettingsPage() {
  const theme = useTheme();
  return (
    <div className="flex w-full max-w-2xl flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-black">Tampilan</h1>
        <FormHint>Pilihan ini tersimpan di perangkat ini saja, tidak mempengaruhi pengguna lain.</FormHint>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Tema">
        {OPTIONS.map(({ key, label, hint, icon: Icon }) => {
          const active = theme === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setTheme(key)}
              className={`flex flex-col items-start gap-1 rounded-xl border p-4 text-left shadow-sm ${
                active ? "border-blue-600 ring-2 ring-blue-600/40" : "border-slate-200 hover:bg-slate-50"
              } bg-white`}
            >
              <Icon className="h-5 w-5 text-slate-600" />
              <span className="text-sm font-semibold text-black">{label}</span>
              <span className="text-xs text-slate-500">{hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
