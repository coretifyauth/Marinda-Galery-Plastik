// Draf form create di localStorage: isian yang belum disimpan supaya gak hilang saat halaman ter-refresh. Dipisah dari hook
// supaya bisa dites tanpa browser. Kunci mengandung user id karena satu perangkat bisa dipakai bergantian.

export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StoredDraft<T> = { savedAt: string; value: T };

export function draftStorageKey(userId: string, formKey: string): string {
  return `erp:draft:v1:${userId}:${formKey}`;
}

/** Null kalau gak ada, rusak, atau kedaluwarsa. Draf yang rusak/kedaluwarsa sekalian dibuang. */
export function readDraft<T>(storage: DraftStorage, key: string, now: number): StoredDraft<T> | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft<T>;
    if (!parsed.savedAt || parsed.value === undefined || now - Date.parse(parsed.savedAt) > DRAFT_TTL_MS) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

/** Gagal menyimpan (kuota penuh, mode privat) gak boleh mengganggu pengisian form. */
export function writeDraft(storage: DraftStorage, key: string, serializedValue: string, now: number): void {
  try {
    storage.setItem(key, `{"savedAt":${JSON.stringify(new Date(now).toISOString())},"value":${serializedValue}}`);
  } catch {
    // sengaja diabaikan
  }
}
