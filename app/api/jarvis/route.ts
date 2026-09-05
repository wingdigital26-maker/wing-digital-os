import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync, spawn } from "child_process";
import { isCloud } from "@/lib/runtime";
import { VAULT_PATH, readVaultFile } from "@/lib/vaultSource";
import { sbUrl, sbService } from "@/lib/osSupabase";
import { requireStaff, isAuthFailure } from "@/app/api/pipeline/_lib";
import {
  JARVIS_TOOLS,
  WRITE_TOOLS,
  isKnownTool,
  runJarvisTool,
  describeAction,
  toolActivityLine,
} from "@/lib/jarvisTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ───────────────────────────────────────────────────────────────────────────
// Jarvis: Wing Digital's operator assistant.
//
// ENGINES
//   api      Anthropic Messages API tool loop (default when ANTHROPIC_API_KEY
//            is set). Streams text, runs the cloud-safe tools in
//            lib/jarvisTools.ts, and pauses on any WRITE tool until the user
//            confirms it in the chat UI. Works with the PC off.
//   cli      Claude Code CLI on Jack's PC (JARVIS_ENGINE=cli, or no API key
//            and the CLI exists). Free on the subscription but has no
//            confirmation flow; the CLI's own toolset applies.
//   limited  No key and no CLI: a plain readout of the vault state files.
//
// STREAM CONTRACT (text/event-stream, one JSON object per `data:` line)
//   { engine }                       which engine answered
//   { text }                         a chunk of the answer
//   { tool, detail, line }           a tool is running (line = human wording)
//   { tool_done, ok, links }         a tool finished; links point into the OS
//   { pending_action: {...} }        a WRITE tool wants confirmation; the turn
//                                    ends here. The UI re-posts with
//                                    confirm_action_id to run it.
//   { budget: {...} }                spend ceiling refusal or backend outage
//   { error }                        anything else
//   data: [DONE]
//
// MONEY
//   Every model call reserves against the "jarvis" bucket in api_usage
//   (supabase/migrations/0026_api_usage.sql), the bucketed twin of
//   lib/rateLimit.ts. Defaults 200 calls and $3 a day, env-overridable. Fails
//   CLOSED: if the counter is unreachable the call is refused.
//
// CONFIRMATION TOKEN
//   pending_action.id is base64url(payload).base64url(HMAC-SHA256(payload))
//   signed with AUTH_SESSION_SECRET. payload = {tool, args, exp, nonce}. The
//   server executes exactly the tool and args inside the token, never anything
//   the client sends alongside it. 10 minute expiry. Nonces are remembered per
//   instance so a token cannot be replayed on the same server.
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-5";
function modelId(): string {
  return (process.env.JARVIS_MODEL || DEFAULT_MODEL).trim();
}

// $ per million tokens. Unknown ids fall back to the Sonnet rate.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
function priceFor(model: string) {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL];
}
function costUsd(model: string, u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): number {
  const p = priceFor(model);
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}
// Pessimistic pre-charge: full input at the model's rate plus a 1200 token answer.
function estimateUsd(model: string, inputChars: number): number {
  const p = priceFor(model);
  return ((inputChars / 3.5) * p.input + 1200 * p.output) / 1_000_000;
}

// ── Spend ceiling (bucket "jarvis") ──────────────────────────────────────────
type Limits = { burstLimit: number; burstSecs: number; ipDaily: number; globalDaily: number; spendUsd: number };
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
function jarvisLimits(): Limits {
  return {
    burstLimit: num("JARVIS_RATE_BURST", 20),
    burstSecs: num("JARVIS_RATE_BURST_SECS", 60),
    ipDaily: num("JARVIS_RATE_IP_DAILY", 200),
    globalDaily: num("JARVIS_RATE_GLOBAL_DAILY", 200),
    spendUsd: num("JARVIS_DAILY_SPEND_USD", 3),
  };
}
type Reservation =
  | { ok: true; dayCalls: number; daySpend: number }
  | { ok: false; reason: string; retryAfter: number; detail: string };

async function usageRpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) throw new Error("OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY not set");
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${fn} -> ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}

const BUDGET_WORDS: Record<string, string> = {
  burst: "Jarvis is being asked too much too fast. Give it a minute.",
  ip_daily: "This device has used up today's Jarvis allowance.",
  global_daily: "Jarvis has used today's call allowance. It resets at midnight UTC.",
  spend: "Jarvis has hit today's spend ceiling. It resets at midnight UTC.",
  backend: "Jarvis could not reach the spend counter, so it refused to spend. Try again shortly.",
};

async function reserveJarvis(ip: string, limits: Limits, est: number): Promise<Reservation> {
  let rows: unknown;
  try {
    rows = await usageRpc("api_rate_reserve", {
      p_bucket: "jarvis", p_ip: ip,
      p_burst_limit: limits.burstLimit, p_burst_secs: limits.burstSecs,
      p_ip_limit: limits.ipDaily, p_day_limit: limits.globalDaily,
      p_spend_limit: limits.spendUsd, p_est: est,
    });
  } catch (e) {
    return { ok: false, reason: "backend", retryAfter: 60, detail: String(e).slice(0, 200) };
  }
  const row = (Array.isArray(rows) ? rows[0] : rows) as Record<string, unknown> | undefined;
  if (!row || typeof row.allowed !== "boolean") return { ok: false, reason: "backend", retryAfter: 60, detail: "no decision returned" };
  if (row.allowed) return { ok: true, dayCalls: Number(row.day_calls) || 0, daySpend: Number(row.day_spend) || 0 };
  const reason = String(row.reason);
  return { ok: false, reason: reason in BUDGET_WORDS ? reason : "backend", retryAfter: Math.max(1, Number(row.retry_after) || 60), detail: reason };
}
async function settleJarvis(ip: string, est: number, actual: number): Promise<void> {
  const delta = actual - est;
  if (Math.abs(delta) < 0.000001) return;
  try {
    await usageRpc("api_rate_settle", { p_bucket: "jarvis", p_ip: ip, p_delta: delta });
  } catch {
    // The estimate stands, which errs conservative.
  }
}
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return xff.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

// ── Confirmation token ───────────────────────────────────────────────────────
const TOKEN_TTL_MS = 10 * 60 * 1000;
const usedNonces = new Map<string, number>(); // nonce -> exp (per instance)
const b64u = (b: Buffer) => b.toString("base64url");
function secret(): string | null {
  const s = process.env.AUTH_SESSION_SECRET;
  return s && s.length >= 16 ? s : null;
}
function signAction(tool: string, args: unknown): string | null {
  const s = secret();
  if (!s) return null;
  const payload = Buffer.from(JSON.stringify({ tool, args, exp: Date.now() + TOKEN_TTL_MS, nonce: crypto.randomBytes(12).toString("hex") }));
  const mac = crypto.createHmac("sha256", s).update(payload).digest();
  return `${b64u(payload)}.${b64u(mac)}`;
}
function verifyAction(token: string): { tool: string; args: unknown } | { error: string } {
  const s = secret();
  if (!s) return { error: "AUTH_SESSION_SECRET is not set, so actions cannot be confirmed." };
  const [p, m] = token.split(".");
  if (!p || !m) return { error: "malformed confirmation token" };
  let payload: Buffer;
  let mac: Buffer;
  try {
    payload = Buffer.from(p, "base64url");
    mac = Buffer.from(m, "base64url");
  } catch {
    return { error: "malformed confirmation token" };
  }
  const expected = crypto.createHmac("sha256", s).update(payload).digest();
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return { error: "confirmation token failed its signature check" };
  let data: { tool?: string; args?: unknown; exp?: number; nonce?: string };
  try {
    data = JSON.parse(payload.toString("utf8"));
  } catch {
    return { error: "malformed confirmation token" };
  }
  if (!data.tool || typeof data.exp !== "number" || !data.nonce) return { error: "malformed confirmation token" };
  if (Date.now() > data.exp) return { error: "that confirmation expired (10 minute limit). Ask again." };
  for (const [n, exp] of usedNonces) if (exp < Date.now()) usedNonces.delete(n);
  if (usedNonces.has(data.nonce)) return { error: "that action was already run once." };
  usedNonces.set(data.nonce, data.exp);
  if (!isKnownTool(data.tool) || !WRITE_TOOLS.has(data.tool)) return { error: "that token is not for a confirmable action" };
  return { tool: data.tool, args: data.args ?? {} };
}

// ── System prompt ────────────────────────────────────────────────────────────
function centralNow(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date());
}

const SYSTEM_PROMPT = `You are Jarvis, the operator assistant inside Wing Digital OS. Wing Digital is a DFW marketing agency run by Jack Wing. You work for Jack and his staff; you are talking to one of them now.

WHAT THE OS CONTAINS
The OS is Wing Digital's own system, built after GoHighLevel was retired in August 2026. Everything lives in the OS database and you reach it through tools:
- CRM: contacts, tags, notes, activities, deals moving through pipeline stages, follow-up tasks.
- Automations: workflows that fire on events (form filled, contact created, booking made, text received, call missed, call logged, deal moved, task done, manual run). Actions include tags, notes, deals, stage moves, tasks, sequence enrollment, texts, emails, push, webhooks, and wait steps that pause a run for hours or until a time on the event.
- Forms: public endpoints that create submissions, contacts and events.
- Booking: a public 30-minute booking page with team availability; bookings are assigned to whoever on the team is free.
- Messaging: an SMS and email ledger. Texts and emails written by automations or by you are DRAFTS unless sending has been switched on for the deployment. Say "drafted, not sent" and mean it.
- Sequences: multi-step email sequences. Activating one sends nothing; an external sender polls the due list.
- Potential clients: business websites dropped in for research and tracked toward a proposal.
- Clients and revenue: the client roster with MRR and its basis, one-time and pipeline money kept separate.
- Agents: scheduled background agents that report heartbeats, and a watchdog report called Da Boss that says whether everything is running.
- The vault: Jack's Obsidian notes (wiki pages, state snapshots, logs).

HOW TO WORK
- Prefer tools over memory. Anything about current numbers, contacts, tasks, bookings, automations, clients, money or system health comes from a tool call, never from recollection. This prompt tells you what exists, not what is in it.
- Read tools run immediately. Write tools (create, complete, tag, note, move, draft, pause, activate, add, cancel, run) are not executed when you call them: the OS shows the user a confirmation card with Do it and Cancel buttons, and only runs the tool after Do it. So when the user asks you to do something, CALL the write tool straight away with the right arguments. Never ask "confirm?" or "shall I?" in text first; the card is the confirmation. One write per turn. When you need a contact or deal id, search first, then call the write tool in the same turn. Do not ask the user for ids they would not know.
- When a tool says a value is null, could_not_check, or returned an error, say "I could not check that" and name what failed. Never fill a gap with a guess, a zero, or a plausible-sounding figure. Never state a client name, dollar amount or count a tool did not return.
- Some tools need Jack's PC. If one answers pcRequired, say so plainly and offer what the cloud can do instead.
- Money words are exact: MRR means confirmed recurring only. One-time, expected and unconfirmed amounts are never called MRR.
- No em dashes. Plain English. No hype.

STYLE
Replies may be read aloud, so lead with the answer and stop. Default length is two to four short sentences. No bullet points, headers, markdown symbols, emojis or decorative characters. Give numbers plainly and in context. If there is more depth, end with a short offer such as "Want the list?" and wait. Tone: a calm, direct chief of staff. No filler, no restating the question, no apologies for tool limits, just the fact and the next step.

After a confirmed action runs, report what actually happened from the tool result in one or two sentences, including the id it created when there is one.`;

function systemBlocks() {
  return [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Current date and time in Central time: ${centralNow()}. Deployment: ${isCloud() ? "cloud (Jack's PC may be off)" : "Jack's PC"}.` },
  ];
}

// ── Anthropic streaming call (raw HTTP, matching the rest of this file) ──────
type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type StreamResult = { blocks: Block[]; stopReason: string | null; usage: Usage };

async function streamAnthropic(opts: {
  apiKey: string;
  model: string;
  messages: unknown[];
  onText: (t: string) => void;
  signal: AbortSignal;
}): Promise<StreamResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 2000,
      stream: true,
      system: systemBlocks(),
      tools: JARVIS_TOOLS,
      messages: opts.messages,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 300)}`);
  }
  const blocks: Block[] = [];
  const partialJson: Record<number, string> = {};
  const usage: Usage = {};
  let stopReason: string | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (ev: Record<string, unknown>) => {
    const type = ev.type as string;
    if (type === "message_start") {
      const u = (ev.message as { usage?: Usage })?.usage;
      if (u) Object.assign(usage, u);
    } else if (type === "content_block_start") {
      const idx = ev.index as number;
      const cb = ev.content_block as { type: string; id?: string; name?: string; text?: string };
      if (cb.type === "text") blocks[idx] = { type: "text", text: cb.text ?? "" };
      else if (cb.type === "tool_use") {
        blocks[idx] = { type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: {} };
        partialJson[idx] = "";
      }
    } else if (type === "content_block_delta") {
      const idx = ev.index as number;
      const d = ev.delta as { type: string; text?: string; partial_json?: string };
      if (d.type === "text_delta" && d.text) {
        const b = blocks[idx];
        if (b && b.type === "text") b.text += d.text;
        opts.onText(d.text);
      } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        partialJson[idx] = (partialJson[idx] ?? "") + d.partial_json;
      }
    } else if (type === "content_block_stop") {
      const idx = ev.index as number;
      const b = blocks[idx];
      if (b && b.type === "tool_use") {
        const raw = partialJson[idx] ?? "";
        try {
          b.input = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          b.input = {};
        }
      }
    } else if (type === "message_delta") {
      const d = ev.delta as { stop_reason?: string };
      if (d?.stop_reason) stopReason = d.stop_reason;
      const u = ev.usage as Usage | undefined;
      if (u) Object.assign(usage, u);
    } else if (type === "error") {
      throw new Error(`stream error: ${JSON.stringify(ev.error).slice(0, 200)}`);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        handle(JSON.parse(data));
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("stream error")) throw e;
      }
    }
  }
  return { blocks: blocks.filter(Boolean), stopReason, usage };
}

// ── API engine: the tool loop with the confirmation pause ────────────────────
type Send = (obj: Record<string, unknown>) => void;

async function runApiLoop(opts: {
  send: Send;
  messages: unknown[];
  apiKey: string;
  ip: string;
  signal: AbortSignal;
  spendOverride: number | null;
}) {
  const { send, messages, apiKey, ip, signal } = opts;
  const model = modelId();
  const limits = jarvisLimits();
  if (opts.spendOverride !== null) limits.spendUsd = opts.spendOverride;
  const MAX_TURNS = 8;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const inputChars = JSON.stringify(messages).length + SYSTEM_PROMPT.length + 12000;
    const est = estimateUsd(model, inputChars);
    const r = await reserveJarvis(ip, limits, est);
    if (!r.ok) {
      send({ budget: { refused: true, reason: r.reason, retryAfter: r.retryAfter, detail: r.detail } });
      send({ text: BUDGET_WORDS[r.reason] ?? BUDGET_WORDS.backend });
      return;
    }
    let result: StreamResult;
    try {
      result = await streamAnthropic({ apiKey, model, messages, onText: (t) => send({ text: t }), signal });
    } catch (e) {
      await settleJarvis(ip, est, 0);
      throw e;
    }
    await settleJarvis(ip, est, costUsd(model, result.usage));
    send({ usage: { model, ...result.usage, cost_usd: Number(costUsd(model, result.usage).toFixed(5)) } });

    if (result.stopReason !== "tool_use") return;

    const toolUses = result.blocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    messages.push({ role: "assistant", content: result.blocks });

    // A WRITE tool ends the turn with a pending_action. The other tool_use
    // blocks in the same message get a "not run" result so the transcript
    // stays valid if the client ever replays it; in practice the client
    // continues with plain text history.
    const pendingWrite = toolUses.find((t) => WRITE_TOOLS.has(t.name));
    if (pendingWrite) {
      const id = signAction(pendingWrite.name, pendingWrite.input);
      if (!id) {
        send({ text: "\n\nI cannot run actions right now: AUTH_SESSION_SECRET is not set on this deployment, so there is no way to sign a confirmation." });
        return;
      }
      send({
        pending_action: {
          id,
          tool: pendingWrite.name,
          args: pendingWrite.input,
          human_summary: describeAction(pendingWrite.name, pendingWrite.input),
          expires_in_sec: TOKEN_TTL_MS / 1000,
        },
      });
      return;
    }

    const results: unknown[] = [];
    for (const tu of toolUses) {
      send({ tool: tu.name, detail: "", line: toolActivityLine(tu.name, tu.input) });
      const out = await runJarvisTool(tu.name, tu.input);
      let ok = true;
      try {
        const parsed = JSON.parse(out.content);
        ok = !(parsed && typeof parsed === "object" && ("error" in parsed || parsed.pcRequired));
      } catch {
        /* non-JSON content is a successful read */
      }
      send({ tool_done: tu.name, ok, links: out.links ?? [] });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out.content });
    }
    messages.push({ role: "user", content: results });
  }
  send({ text: "\n\n(I stopped after several tool steps. Ask me to continue if you need more.)" });
}

// Runs a confirmed WRITE tool, then lets the model report on the result.
async function runConfirmed(opts: {
  send: Send;
  messages: unknown[];
  token: string;
  apiKey: string | null;
  ip: string;
  signal: AbortSignal;
  spendOverride: number | null;
}) {
  const v = verifyAction(opts.token);
  if ("error" in v) {
    opts.send({ text: `I did not run that: ${v.error}` });
    return;
  }
  opts.send({ tool: v.tool, detail: "", line: toolActivityLine(v.tool, v.args) });
  const out = await runJarvisTool(v.tool, v.args);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(out.content);
  } catch {
    parsed = null;
  }
  const ok = !(parsed && ("error" in parsed || parsed.pcRequired));
  opts.send({ tool_done: v.tool, ok, links: out.links ?? [], result: parsed ?? out.content.slice(0, 500) });

  if (!opts.apiKey) {
    // No model available to narrate: report the raw outcome honestly.
    opts.send({ text: ok ? `Done: ${describeAction(v.tool, v.args)}.` : `That did not work: ${out.content.slice(0, 300)}` });
    return;
  }
  opts.messages.push({
    role: "user",
    content: `[System note] The user confirmed the action "${describeAction(v.tool, v.args)}" and it was executed. Tool ${v.tool} returned:\n${out.content.slice(0, 4000)}\nReport what happened in one or two plain sentences. Do not call this tool again for the same request.`,
  });
  await runApiLoop({ send: opts.send, messages: opts.messages, apiKey: opts.apiKey, ip: opts.ip, signal: opts.signal, spendOverride: opts.spendOverride });
}

// ── Claude Code CLI engine (PC only, opt-in) ─────────────────────────────────
const CLI_STYLE_PROMPT =
  "You are Jarvis, Jack Wing's voice assistant for Wing Digital OS. Your reply is read aloud by TTS. " +
  "Hard style rules: lead with the answer; 2-4 short sentences by default; no bullet lists, headers, markdown symbols, emojis, or decorative unicode; " +
  "give numbers plainly; if more depth exists, offer it briefly instead of dumping it. No em dashes. Sound like a competent chief of staff.";
const CLAUDE_CODE_TIMEOUT_MS = 180_000;
const SESSION_FILE = "C:\\Users\\wjack\\wing-digital-os\\.jarvis-session.json";
let cachedCliPath: string | null | undefined;

function findClaudeCli(): string | null {
  if (isCloud()) return null;
  if (cachedCliPath !== undefined) return cachedCliPath;
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    path.join(process.env.USERPROFILE ?? "C:\\Users\\wjack", ".local", "bin", "claude.exe"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) { cachedCliPath = c; return c; }
    } catch { /* keep looking */ }
  }
  try {
    const out = execFileSync("where", ["claude"], { encoding: "utf-8", timeout: 5000 });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l));
    if (first) { cachedCliPath = first; return first; }
  } catch { /* not on PATH */ }
  cachedCliPath = null;
  return null;
}

function readSessions(): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
function saveSession(conversationId: string, sessionId: string) {
  try {
    const sessions = readSessions();
    sessions[conversationId] = sessionId;
    const keys = Object.keys(sessions);
    if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete sessions[k];
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2), "utf-8");
  } catch { /* continuity degrades to fresh sessions */ }
}

function runClaudeCode(opts: { cli: string; userText: string; conversationId: string | null; send: Send; signal: AbortSignal }): Promise<boolean> {
  return new Promise((resolve) => {
    const { cli, userText, conversationId, send, signal } = opts;
    const prevSession = conversationId ? readSessions()[conversationId] : undefined;
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions", "--append-system-prompt", CLI_STYLE_PROMPT];
    if (prevSession) args.push("--resume", prevSession);
    args.push(userText);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, args, { cwd: VAULT_PATH, windowsHide: true, env: process.env });
    } catch {
      resolve(false);
      return;
    }
    let committed = false, done = false, sawDelta = false, anyText = false, resultText = "", buffer = "";
    const commit = () => { if (!committed) { committed = true; send({ engine: "claude-code" }); } };
    const kill = () => { try { child.kill(); } catch { /* dead */ } };
    const onAbort = () => kill();
    signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => { if (committed) send({ text: "\n\n(Jarvis timed out after 180s. The CLI task was stopped.)" }); kill(); }, CLAUDE_CODE_TIMEOUT_MS);
    const handleLine = (line: string) => {
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line); } catch { return; }
      commit();
      if (ev.type === "system" && ev.subtype === "init") {
        if (conversationId && ev.session_id) saveSession(conversationId, String(ev.session_id));
      } else if (ev.type === "stream_event") {
        const e = ev.event as { type?: string; delta?: { type?: string; text?: string } };
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) { sawDelta = true; anyText = true; send({ text: e.delta.text }); }
      } else if (ev.type === "assistant") {
        const blocks = ((ev.message as { content?: unknown[] })?.content ?? []) as { type: string; name?: string; text?: string }[];
        for (const b of blocks) {
          if (b.type === "tool_use") send({ tool: b.name, detail: "", line: `Ran ${b.name}` });
          else if (b.type === "text" && b.text && !sawDelta) { anyText = true; send({ text: b.text }); }
        }
      } else if (ev.type === "result") {
        if (typeof ev.result === "string") resultText = ev.result;
        if (conversationId && ev.session_id) saveSession(conversationId, String(ev.session_id));
      }
    };
    child.stdout?.on("data", (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1); if (line) handleLine(line); }
    });
    child.stderr?.on("data", () => { /* progress noise */ });
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(ok); };
    child.on("error", () => { if (!committed) finish(false); });
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer.trim());
      if (!committed) { finish(false); return; }
      if (!anyText && resultText) send({ text: resultText });
      else if (!anyText && code !== 0 && !signal.aborted) send({ text: "(Jarvis/Claude Code exited without a reply. Try again.)" });
      finish(true);
    });
  });
}

// ── Limited mode: no key, no CLI ─────────────────────────────────────────────
async function runLimitedMode(send: Send, userText: string) {
  send({ engine: "limited" });
  const [biz, outreach, hot, log] = await Promise.all([
    readVaultFile("wiki/state/business-snapshot.md"),
    readVaultFile("wiki/state/outreach-snapshot.md"),
    readVaultFile("wiki/hot.md"),
    readVaultFile("wiki/log.md"),
  ]);
  const parts: string[] = ["Limited mode: no AI backend is reachable from here, so this is a direct readout of the live OS state files.\n"];
  const q = userText.toLowerCase();
  const wantAll = !/(outreach|email|pipeline|client|mrr|focus|log|activity|agent)/.test(q);
  if (biz && (wantAll || /client|mrr|business|money|revenue/.test(q))) parts.push("BUSINESS SNAPSHOT\n" + biz.trim().slice(0, 1200));
  if (outreach && (wantAll || /outreach|email|pipeline|lead|prospect|sent/.test(q))) parts.push("\nOUTREACH SNAPSHOT\n" + outreach.trim().slice(0, 1200));
  if (hot && (wantAll || /focus|priorit|question|decision|next/.test(q))) parts.push("\nCURRENT FOCUS (hot.md)\n" + hot.trim().slice(0, 1000));
  if (log && (wantAll || /log|activity|agent|recent|happen|today/.test(q))) {
    const recent = log.split(/\r?\n/).filter((l) => l.startsWith("## ")).slice(-8).join("\n");
    if (recent) parts.push("\nRECENT ACTIVITY (log.md)\n" + recent);
  }
  if (parts.length === 1) parts.push("No vault state files are reachable right now.");
  send({ text: parts.join("\n") });
}

// ── Handler ──────────────────────────────────────────────────────────────────
const MAX_HISTORY = 40; // 20 turns

export async function POST(req: NextRequest) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Body must be JSON." }, { status: 400 });
  }
  const incoming = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  const conversationId = typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim().slice(0, 100) : null;
  const confirmToken = typeof body.confirm_action_id === "string" ? body.confirm_action_id : null;

  // History is plain text turns from the browser; the server keeps no chat state.
  const messages: unknown[] = incoming
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && (m.content as string).trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: (m.content as string).slice(0, 8000) }));
  // The API needs the transcript to start with a user turn and never to end
  // on an assistant turn when we are not confirming; drop leading assistant turns.
  while (messages.length && (messages[0] as { role: string }).role !== "user") messages.shift();
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  const userText = typeof lastUser?.content === "string" ? lastUser.content : "";

  const apiKey = process.env.ANTHROPIC_API_KEY || null;
  const ip = clientIp(req);
  // Local testing only: a request header can lower the spend ceiling to prove
  // the refusal path. Ignored in production and in the cloud.
  const overrideRaw = req.headers.get("x-jarvis-spend-ceiling");
  const spendOverride =
    overrideRaw !== null && process.env.NODE_ENV !== "production" && !isCloud() && Number.isFinite(Number(overrideRaw))
      ? Number(overrideRaw)
      : null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send: Send = (obj) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        if (confirmToken) {
          send({ engine: "api" });
          await runConfirmed({ send, messages, token: confirmToken, apiKey, ip, signal: req.signal, spendOverride });
        } else if (!messages.length) {
          send({ text: "Say something and I will get to work." });
        } else {
          const preferCli = process.env.JARVIS_ENGINE === "cli" || !apiKey;
          const cli = preferCli ? findClaudeCli() : null;
          let handled = false;
          if (cli && userText) {
            handled = await runClaudeCode({ cli, userText, conversationId, send, signal: req.signal });
          }
          if (!handled) {
            if (apiKey) {
              send({ engine: "api" });
              await runApiLoop({ send, messages, apiKey, ip, signal: req.signal, spendOverride });
            } else {
              await runLimitedMode(send, userText);
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send({ error: msg.slice(0, 300) });
        send({ text: `\n\n(Jarvis hit an error: ${msg.slice(0, 200)})` });
      } finally {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch { /* already closed */ }
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
