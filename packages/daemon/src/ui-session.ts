// In-memory-only browser-credential state for `fern ui` — never
// persisted, cleared on every daemon restart (a fresh token is minted
// on boot too, so nothing here outlives the process that issued it).
// Two separate maps, deliberately: a 30-second, single-use code (the
// handoff's first step — see server.ts's POST /ui-code) and a longer-
// lived, capped set of session tokens (what the browser's cookie
// actually carries after exchanging a code via POST /session). The raw
// daemon token never appears in either — see docs/decisions.md.

import { timingSafeStringEquals } from "./protocol";

const CODE_TTL_MS = 30_000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;

interface Expiring {
  expiresAt: number;
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export class UiSessionStore {
  private codes = new Map<string, Expiring>();
  private sessions = new Map<string, Expiring>();

  mintCode(now: number = Date.now()): string {
    const code = randomId();
    this.codes.set(code, { expiresAt: now + CODE_TTL_MS });
    return code;
  }

  /**
   * Consumed on first lookup regardless of outcome — a reused or
   * expired code always fails, never gets a second chance. Reports
   * *why* it failed so the UI can show something more useful than a
   * bare "forbidden": "expired" (it existed and its TTL had passed) is
   * distinguishable from "unknown" (it was never minted, or — the
   * common case — it already got consumed by an earlier redeem, which
   * looks identical to a fabricated code by design: single-use means
   * there's no way to tell those two apart after the fact, nor should
   * there be).
   */
  redeemCode(
    code: string,
    now: number = Date.now(),
  ): "ok" | "expired" | "unknown" {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (entry === undefined) return "unknown";
    return entry.expiresAt > now ? "ok" : "expired";
  }

  mintSession(now: number = Date.now()): string {
    this.evictExpiredSessions(now);
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) this.sessions.delete(oldestKey);
    }
    const token = randomId();
    this.sessions.set(token, { expiresAt: now + SESSION_TTL_MS });
    return token;
  }

  /**
   * Constant-time, like server.ts's raw-token check (tokenMatches) —
   * a plain `Map.get(token)` looks up by hashing the provided string,
   * which doesn't protect against a timing attacker probing the
   * session cookie's real value byte-by-byte the way a direct
   * `timingSafeEqual` does. Scans every live session (bounded by
   * MAX_SESSIONS) rather than returning as soon as a match is found,
   * so the match itself doesn't introduce its own early-exit timing
   * signal.
   */
  isValidSession(token: string, now: number = Date.now()): boolean {
    let matchedKey: string | null = null;
    for (const key of this.sessions.keys()) {
      if (timingSafeStringEquals(token, key)) matchedKey = key;
    }
    if (matchedKey === null) return false;
    const entry = this.sessions.get(matchedKey);
    if (!entry || entry.expiresAt <= now) {
      this.sessions.delete(matchedKey);
      return false;
    }
    return true;
  }

  private evictExpiredSessions(now: number): void {
    for (const [key, entry] of this.sessions) {
      if (entry.expiresAt <= now) this.sessions.delete(key);
    }
  }
}
