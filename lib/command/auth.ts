// Who is signed in to the Command Center. Server-only.
//
// Two ways in, both on the OS's existing signed-session cookie (wingos_session,
// AUTH_SESSION_SECRET), so the proxy gate already understands them:
//   1. Per-user codes at /command/login. Env: COMMAND_CODE_JACK,
//      COMMAND_CODE_GRANT, COMMAND_CODE_DYLAN. A user with no code set cannot
//      sign in at all (fail closed). Jack gets role "admin" (whole OS); Grant
//      and Dylan get role "member", which proxy.ts limits to /command only.
//   2. Jack's existing OS login (staff session or the OS_PASSWORD cookie)
//      counts as Jack.
import crypto from "node:crypto";
import { getOsSession, hasLegacyAuth } from "../osSupabase";
import { USERS, type UserId } from "./team";

export type CommandUser = { id: UserId; admin: boolean };

export const SESSION_PREFIX = "cc:";

export function codeFor(id: UserId): string | null {
  const v = process.env[`COMMAND_CODE_${id.toUpperCase()}`];
  return v && v.trim().length >= 6 ? v.trim() : null;
}

/** Constant-time code check. False when the user has no code configured. */
export function codeMatches(id: UserId, presented: string): boolean {
  const expected = codeFor(id);
  if (!expected || !presented) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(presented.trim()).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function currentUser(): Promise<CommandUser | null> {
  const s = await getOsSession();
  if (s) {
    if (s.sub.startsWith(SESSION_PREFIX)) {
      const id = s.sub.slice(SESSION_PREFIX.length) as UserId;
      if (USERS.includes(id)) return { id, admin: id === "jack" };
      return null;
    }
    if (s.role === "admin" || s.role === "owner" || s.role === "staff") {
      return { id: "jack", admin: true };
    }
    return null;
  }
  if (await hasLegacyAuth()) return { id: "jack", admin: true };
  return null;
}
