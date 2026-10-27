// Shared plumbing for /api/command/* routes. Server-only.
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { currentUser, type CommandUser } from "./auth";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function fail(error: string, status = 400) {
  return json({ ok: false, error }, status);
}

/** The signed-in teammate, or a 401 response to return as-is. */
export async function requireUser(): Promise<CommandUser | NextResponse> {
  const u = await currentUser();
  return u ?? fail("Sign in to the Command Center first.", 401);
}

export async function requireAdmin(): Promise<CommandUser | NextResponse> {
  const u = await currentUser();
  if (!u) return fail("Sign in to the Command Center first.", 401);
  if (!u.admin) return fail("Only Jack can do that.", 403);
  return u;
}

function safeEq(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * Machine callers (the daily routine, Jack's laptop sync, content agents).
 * Accepts `Authorization: Bearer <COMMAND_MACHINE_KEY>` or `x-command-key`.
 * CRON_SECRET is accepted too so a Vercel cron can call the check. Fails
 * closed: with no key configured, no machine call is accepted.
 */
export function machineAuthorized(req: Request): boolean {
  const keys = [process.env.COMMAND_MACHINE_KEY, process.env.CRON_SECRET].filter(
    (k): k is string => Boolean(k && k.length >= 16)
  );
  if (!keys.length) return false;
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const presented = req.headers.get("x-command-key") || bearer;
  if (!presented) return false;
  return keys.some((k) => safeEq(k, presented));
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}

export function text(v: unknown, max = 2000): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export function day(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export function isResponse(x: unknown): x is NextResponse {
  return x instanceof NextResponse;
}
