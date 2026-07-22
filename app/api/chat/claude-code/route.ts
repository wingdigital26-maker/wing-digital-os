import { NextRequest, NextResponse } from "next/server";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

// Persistent bridge to Claude Code (headless stream mode).
// The process boots ONCE and stays warm; each chat message is written to its stdin
// and the reply is read from stdout. Same Claude as the terminal: full toolkit,
// CLAUDE.md, vault, memory, skills. Billed to the Claude subscription.

const CLAUDE_BIN = "C:\\Users\\wjack\\.local\\bin\\claude.exe";
const VAULT_CWD = "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

interface CCBridge {
  proc: ChildProcessWithoutNullStreams;
  busy: boolean;
  buffer: string;
  resolve: ((r: { reply: string }) => void) | null;
  lastText: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __ccBridge: CCBridge | undefined;
}

function startBridge(): CCBridge {
  const proc = spawn(CLAUDE_BIN, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
  ], {
    cwd: VAULT_CWD,
    windowsHide: true,
    env: process.env,
  });

  const bridge: CCBridge = { proc, busy: false, buffer: "", resolve: null, lastText: "" };

  proc.stdout.on("data", (d) => {
    bridge.buffer += d.toString();
    let nl;
    while ((nl = bridge.buffer.indexOf("\n")) >= 0) {
      const line = bridge.buffer.slice(0, nl).trim();
      bridge.buffer = bridge.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "assistant") {
          // Accumulate latest assistant text (final one wins)
          const text = (ev.message?.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("");
          if (text) bridge.lastText = text;
        } else if (ev.type === "result") {
          const reply = ev.result ?? bridge.lastText ?? "(no output)";
          bridge.lastText = "";
          bridge.busy = false;
          bridge.resolve?.({ reply });
          bridge.resolve = null;
        }
      } catch { /* ignore non-JSON lines */ }
    }
  });

  proc.stderr.on("data", () => { /* progress noise */ });

  proc.on("close", () => {
    if (globalThis.__ccBridge === bridge) globalThis.__ccBridge = undefined;
    bridge.resolve?.({ reply: "Claude Code process exited. Next message will restart it." });
    bridge.resolve = null;
  });

  return bridge;
}

function getBridge(fresh: boolean): CCBridge {
  let b = globalThis.__ccBridge;
  if (fresh && b) {
    try { b.proc.kill(); } catch { }
    b = undefined;
  }
  if (!b || b.proc.exitCode !== null) {
    b = startBridge();
    globalThis.__ccBridge = b;
  }
  return b;
}

function ask(bridge: CCBridge, text: string): Promise<{ reply: string }> {
  return new Promise((resolve) => {
    bridge.busy = true;
    bridge.resolve = resolve;
    const timer = setTimeout(() => {
      if (bridge.resolve) {
        bridge.resolve({ reply: "Timed out after 5 minutes. The task may still be running." });
        bridge.resolve = null;
        bridge.busy = false;
      }
    }, TURN_TIMEOUT_MS);
    const origResolve = resolve;
    bridge.resolve = (r) => { clearTimeout(timer); origResolve(r); };

    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    bridge.proc.stdin.write(msg + "\n");
  });
}

export async function POST(req: NextRequest) {
  const { messages } = await req.json();
  const userMessages = (messages ?? []).filter((m: any) => m.role === "user");
  const last = userMessages[userMessages.length - 1];
  if (!last?.content) {
    return NextResponse.json({ reply: "No message received.", cost: 0, toolCalls: [] });
  }

  // First message of a conversation → fresh process/session
  const fresh = userMessages.length <= 1;
  const bridge = getBridge(fresh);

  if (bridge.busy) {
    return NextResponse.json({ reply: "Still working on the previous message — give it a moment.", cost: 0, toolCalls: [] });
  }

  const res = await ask(bridge, String(last.content));
  return NextResponse.json({ reply: res.reply, cost: 0, toolCalls: [] });
}
