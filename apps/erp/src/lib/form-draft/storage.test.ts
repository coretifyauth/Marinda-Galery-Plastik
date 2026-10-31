import { describe, expect, it } from "vitest";
import { DRAFT_TTL_MS, draftStorageKey, readDraft, writeDraft } from "./storage";

function fakeStorage(failOnWrite = false) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failOnWrite) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
}

const now = Date.parse("2026-10-31T10:00:00Z");

describe("form draft storage", () => {
  it("menyimpan dan membaca kembali isian", () => {
    const storage = fakeStorage();
    writeDraft(storage, "k", JSON.stringify({ lines: [{ item_id: "a", qty: "3" }] }), now);
    expect(readDraft<{ lines: unknown[] }>(storage, "k", now)?.value).toEqual({ lines: [{ item_id: "a", qty: "3" }] });
  });

  it("kunci dipisah per user dan per form", () => {
    expect(draftStorageKey("u1", "f")).not.toBe(draftStorageKey("u2", "f"));
    expect(draftStorageKey("u1", "f")).not.toBe(draftStorageKey("u1", "g"));
  });

  it("membuang draf kedaluwarsa", () => {
    const storage = fakeStorage();
    writeDraft(storage, "k", "{}", now);
    expect(readDraft(storage, "k", now + DRAFT_TTL_MS + 1)).toBeNull();
    expect(storage.data.has("k")).toBe(false);
  });

  it("membuang draf rusak tanpa melempar error", () => {
    const storage = fakeStorage();
    storage.setItem("k", "{bukan json");
    expect(readDraft(storage, "k", now)).toBeNull();
    expect(storage.data.has("k")).toBe(false);
  });

  it("gagal menyimpan tidak melempar error", () => {
    expect(() => writeDraft(fakeStorage(true), "k", "{}", now)).not.toThrow();
  });
});
