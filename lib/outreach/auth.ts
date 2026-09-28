// Who is calling an /api/outreach route, and what they may do.
//
//   staff   a signed-in admin/owner/staff session, or the legacy OS password
//           cookie (that one is Jack). Can review, edit, approve, reject.
//   machine the engine on Jack's PC or a GitHub Actions job, presenting
//           x-heartbeat-key = HEARTBEAT_KEY (or Bearer CRON_SECRET for the
//           sync). Can ingest drafts and read approvals. Never approves.
//
// Both checks fail closed: an unset secret authorizes nobody.
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { getOsSession, hasLegacyAuth } from "@/lib/osSupabase";

const STAFF = new Set(["admin", "owner", "staff"]);

function sameSecret(got: string | null | undefined, expected: string | undefined): boolean {
  if (!got || !expected) return false;
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function isMachine(req: NextRequest): boolean {
  if (sameSecret(req.headers.get("x-heartbeat-key"), process.env.HEARTBEAT_KEY)) return true;
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  return sameSecret(bearer, process.env.CRON_SECRET);
}

/** The person acting, as it is written into approver / edited_by. Null = not staff. */
export async function staffActor(): Promise<string | null> {
  const session = await getOsSession();
  if (session && STAFF.has(session.role)) return session.email || `${session.role} ${session.sub.slice(0, 8)}`;
  if (await hasLegacyAuth()) return process.env.OUTREACH_OWNER_NAME?.trim() || "Jack Wing";
  return null;
}

/** The "Push approved to Instantly" switch. Off unless OUTREACH_PUSH_ENABLED is 1 or true. */
export function pushEnabled(): boolean {
  const v = process.env.OUTREACH_PUSH_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true";
}
