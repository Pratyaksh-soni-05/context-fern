// Wire-protocol constants shared between the server (server.ts) and the
// lightweight client (client.ts) — split out so the client never needs
// to import server.ts (which pulls in the whole project-registry/store
// graph). Built from CLI_NAME, never the literal word "fern".

import { timingSafeEqual } from "node:crypto";
import { CLI_NAME } from "@context-fern/core";

export const TOKEN_HEADER = `x-${CLI_NAME}-token`;

/** The browser's session cookie, minted by POST /session in exchange for a one-time code from POST /ui-code — never the raw daemon token. See server.ts and docs/decisions.md. */
export const SESSION_COOKIE_NAME = `${CLI_NAME}_session`;

/**
 * Constant-time string comparison for anything that gates access — the
 * raw daemon token (server.ts's tokenMatches) and the session cookie
 * (ui-session.ts's isValidSession) both use this, so neither leaks its
 * real value byte-by-byte to a timing attacker a hair faster on each
 * correctly-guessed prefix. The length check short-circuits before the
 * timing-safe compare — safe here because every credential this gates
 * is a fixed-length value from `crypto.randomUUID()`-derived generation
 * (see ui-session.ts's randomId()), so a length mismatch reveals
 * nothing about real content, only that the value was never minted by
 * this process at all.
 */
export function timingSafeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
