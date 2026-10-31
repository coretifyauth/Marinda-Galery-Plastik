import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { draftStorageKey, readDraft, writeDraft } from "./storage";

const SAVE_DELAY_MS = 500;

export type FormDraft = {
  /** Waktu draf disimpan, kalau form ini dipulihkan dari draf. */
  restoredAt: string | null;
  /** Naik tiap pemulihan. Pakai di `key` input yang menyimpan isian sendiri dan sudah terpasang sebelum pemulihan. */
  restoreKey: number;
  /** Panggil saat dokumen berhasil disimpan, sebelum pindah halaman. */
  clear: () => void;
  /** Buang draf dan kembalikan form ke kondisi awal. */
  discard: () => void;
};

/**
 * Menyimpan isian form create ke localStorage dan memulihkannya setelah refresh. `enabled` = data awal form sudah selesai dimuat:
 * isian saat itu jadi patokan "form masih kosong", jadi form yang belum disentuh gak meninggalkan draf.
 */
export function useFormDraft<T>(formKey: string, value: T, onRestore: (draft: T) => void, enabled: boolean): FormDraft {
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const [restoreKey, setRestoreKey] = useState(0);
  const storageKeyRef = useRef<string | null>(null);
  const baselineRef = useRef<string | null>(null);
  const clearedRef = useRef(false);
  const serialized = JSON.stringify(value);
  const serializedRef = useRef(serialized);
  const onRestoreRef = useRef(onRestore);

  useEffect(() => {
    serializedRef.current = serialized;
    onRestoreRef.current = onRestore;
  });

  const persistRef = useRef(() => {
    const key = storageKeyRef.current;
    if (!key || clearedRef.current) return;
    if (serializedRef.current === baselineRef.current) {
      window.localStorage.removeItem(key);
    } else {
      writeDraft(window.localStorage, key, serializedRef.current, Date.now());
    }
  });

  useEffect(() => {
    if (!enabled) return;
    baselineRef.current ??= serializedRef.current;
    let active = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active || !session) return;
      const key = draftStorageKey(session.user.id, formKey);
      storageKeyRef.current = key;
      const found = readDraft<T>(window.localStorage, key, Date.now());
      if (found) {
        onRestoreRef.current(found.value);
        setRestoredAt(found.savedAt);
        setRestoreKey((k) => k + 1);
      }
    });
    return () => {
      active = false;
    };
  }, [enabled, formKey]);

  useEffect(() => {
    const timer = setTimeout(() => persistRef.current(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [serialized]);

  // Refresh atau pindah halaman sebelum jeda penyimpanan habis.
  useEffect(() => {
    const flush = () => persistRef.current();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  return {
    restoredAt,
    restoreKey,
    clear() {
      clearedRef.current = true;
      if (storageKeyRef.current) window.localStorage.removeItem(storageKeyRef.current);
    },
    discard() {
      clearedRef.current = true;
      if (storageKeyRef.current) window.localStorage.removeItem(storageKeyRef.current);
      window.location.reload();
    },
  };
}
