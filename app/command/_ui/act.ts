"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type ActResult = { ok: boolean; data: Record<string, any>; error: string | null };

export async function act(url: string, method: string, payload: unknown): Promise<ActResult> {
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      window.location.href = "/command/login";
      return { ok: false, data, error: "Signed out." };
    }
    return { ok: r.ok && data.ok !== false, data, error: r.ok ? null : data.error || `Error ${r.status}` };
  } catch {
    return { ok: false, data: {}, error: "No connection. Try again." };
  }
}

/** Send, then refresh the server-rendered screen. Tracks busy + message. */
export function useAct() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(url: string, method: string, payload: unknown, okText?: string) {
    setBusy(true);
    setMsg(null);
    const r = await act(url, method, payload);
    setBusy(false);
    if (r.ok) {
      if (okText) setMsg({ ok: true, text: okText });
      router.refresh();
    } else setMsg({ ok: false, text: r.error || "Something went wrong." });
    return r;
  }
  return { busy, msg, setMsg, run };
}

/** One line under a form saying what happened with the team text. */
export function notifyLine(n: any): string {
  if (!n) return "";
  if (n.off) return " Texts are off, so nobody was texted yet.";
  if (n.sent) return " The team was told.";
  return " The team text did not go through.";
}
