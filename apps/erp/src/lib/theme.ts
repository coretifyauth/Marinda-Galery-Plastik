import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "theme";
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

/** Pasang/cabut kelas `dark` di <html>. Skrip di app/layout.tsx melakukan hal yang sama sebelum halaman tampil (anti-kedip). */
export function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // penyimpanan diblokir (mode privat): tema tetap berlaku untuk sesi ini
  }
  applyTheme(theme);
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // mode "ikuti sistem": ikut berubah saat pengaturan OS berubah
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onOs = () => {
    if (getTheme() === "system") applyTheme("system");
  };
  mq.addEventListener("change", onOs);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    mq.removeEventListener("change", onOs);
    window.removeEventListener("storage", onChange);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => "light" as Theme);
}
