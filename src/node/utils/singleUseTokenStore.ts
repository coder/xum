import { randomBytes } from "node:crypto";
import { log } from "@/node/services/log";

const CLEANUP_INTERVAL_MS = 60_000;

interface StoredToken<T> {
  payload: T;
  expiresAtMs: number;
}

/**
 * Single-use, TTL-bound bearer token store with periodic expired-entry cleanup.
 * Shared by ephemeral local bridge auth managers (browser bridge, desktop bridge).
 */
export class SingleUseTokenStore<T> {
  private readonly tokens = new Map<string, StoredToken<T>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly label: string
  ) {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  mint(payload: T): string {
    let token = "";
    do {
      token = randomBytes(32).toString("hex");
    } while (this.tokens.has(token));

    this.tokens.set(token, {
      payload,
      expiresAtMs: Date.now() + this.ttlMs,
    });

    return token;
  }

  /** Validate and consume a token, returning its payload or null if missing/expired. */
  validate(token: string): T | null {
    const record = this.tokens.get(token);
    if (!record) {
      return null;
    }

    // Single-use tokens are consumed regardless of validation outcome.
    this.tokens.delete(token);

    if (Date.now() > record.expiresAtMs) {
      log.debug(`${this.label}: token expired`, { tokenPrefix: token.slice(0, 8) });
      return null;
    }

    return record.payload;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [token, record] of this.tokens) {
      if (now > record.expiresAtMs) {
        this.tokens.delete(token);
        cleaned += 1;
      }
    }

    if (cleaned > 0) {
      log.debug(`${this.label}: cleaned up expired tokens`, { count: cleaned });
    }
  }

  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.tokens.clear();
  }
}
