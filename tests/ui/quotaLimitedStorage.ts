/** Storage with a character budget that throws like browsers do when the origin quota is full. */
export class QuotaLimitedStorage implements Storage {
  private readonly map = new Map<string, string>();
  readonly setItemCalls: string[] = [];

  constructor(private readonly capacityChars: number) {}

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.setItemCalls.push(key);
    let used = key.length + value.length;
    for (const [existingKey, existingValue] of this.map) {
      if (existingKey !== key) used += existingKey.length + existingValue.length;
    }
    if (used > this.capacityChars) {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    }
    this.map.set(key, value);
  }

  /** Seed without quota checks, like data written by an earlier session. */
  seed(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** Replace the installed DOM window's localStorage (see installDom) with a quota-limited one. */
export function installQuotaLimitedStorage(capacityChars: number): QuotaLimitedStorage {
  const storage = new QuotaLimitedStorage(capacityChars);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return storage;
}
