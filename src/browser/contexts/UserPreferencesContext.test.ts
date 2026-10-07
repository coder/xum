import { describe, expect, test } from "bun:test";

import { createMergePatch, mirrorBackendPreferences } from "./UserPreferencesContext";
import {
  getNotifyOnResponseAutoEnableKey,
  getNotifyOnResponseKey,
} from "@/common/constants/storage";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  setJSON(key: string, value: unknown): void {
    this.setItem(key, JSON.stringify(value));
  }
}

describe("UserPreferencesProvider bridge helpers", () => {
  test("removes stale local cache entries on a backend refresh", () => {
    const storage = new MemoryStorage();
    storage.setJSON(getNotifyOnResponseKey("ws-a"), false);
    storage.setJSON(getNotifyOnResponseAutoEnableKey("/repo"), true);

    mirrorBackendPreferences({
      backendPreferences: { notifications: { notifyOnResponseByWorkspace: { "ws-a": true } } },
      storage,
    });

    expect(JSON.parse(storage.getItem(getNotifyOnResponseKey("ws-a")) ?? "null")).toBe(true);
    expect(storage.getItem(getNotifyOnResponseAutoEnableKey("/repo"))).toBeNull();
  });

  test("removing the last known value of a section deletes only that stored value", () => {
    expect(createMergePatch({ appearance: { theme: "dark" } }, {})).toEqual({
      appearance: { theme: null },
    });
  });
});
