"use client";
// Global command palette (Ctrl+K / Cmd+K). Self-contained: mounts its own
// keydown listener, so wiring is one line: <CommandPalette /> anywhere in the
// shell. Navigation goes through the same paths the shell already honors —
// window "os:navigate" CustomEvents for in-shell views, location.href for
// routed pages. No data is fabricated: every entry below is a real NAV sub
// from app/page.tsx or a real routed page under app/.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Command = {
  id: string;          // stable id (also the recents key)
  label: string;
  group: string;       // section header shown dimmed next to the label
  keywords?: string;   // extra fuzzy-match fodder
  run: () => void;
};

const navigate = (subId: string) => {
  // Off "/" nothing listens for os:navigate — go through the hash route
  // (layout wires a hashchange listener on "/" so this works live too).
  if (window.location.pathname !== "/") {
    window.location.href = "/#view=" + subId;
    return;
  }
  window.dispatchEvent(new CustomEvent("os:navigate", { detail: subId }));
};
const go = (href: string) => { window.location.href = href; };

// ── The registry ─────────────────────────────────────────────────────
// Shell views mirror NAV in app/page.tsx (groups + sub-tabs). Sub ids that
// page.tsx lists in EXTERNAL_SUB_LINKS (sequences, automations, calls) are
// still dispatched via os:navigate — the shell's handler redirects those
// itself, so one path covers both.
const SHELL_VIEWS: { id: string; label: string; group: string; keywords?: string }[] = [
  { id: "command", label: "Overview", group: "Command Center", keywords: "home dashboard" },
  { id: "today", label: "Today", group: "Command Center", keywords: "agenda daily" },
  { id: "personal", label: "Personal", group: "Command Center" },
  { id: "clients", label: "Clients", group: "Clients" },
  { id: "potential", label: "Potential clients", group: "Clients", keywords: "prospects" },
  { id: "sonar", label: "Sonar Leads", group: "Clients", keywords: "leads" },
  { id: "storms", label: "Storm Response", group: "Clients", keywords: "hail" },
  { id: "crm", label: "Everything", group: "CRM", keywords: "contacts pipeline inbox outbound" },
  { id: "email", label: "Email", group: "CRM", keywords: "messaging deliverability" },
  { id: "text", label: "Text", group: "CRM", keywords: "sms messages" },
  { id: "replies", label: "Reply Inbox", group: "CRM", keywords: "inbound" },
  { id: "automations", label: "Automations", group: "Automations", keywords: "workflows" },
  { id: "sequences", label: "Sequences", group: "Automations" },
  { id: "calls", label: "Call Room", group: "Automations", keywords: "cold calling dialer" },
  { id: "social", label: "Social", group: "Marketing", keywords: "posts schedule" },
  { id: "reviews", label: "Reviews", group: "Marketing" },
  { id: "customers", label: "Customers", group: "Marketing" },
  { id: "calendar", label: "Calendar", group: "Calendar", keywords: "schedule invoices" },
  { id: "agent", label: "Mission Control", group: "Agents", keywords: "agents" },
  { id: "knowledge", label: "Knowledge Base", group: "Intel", keywords: "notes vault" },
  { id: "competitors", label: "Competitor Intel", group: "Intel", keywords: "research" },
];

const ROUTED_PAGES: { href: string; label: string; keywords?: string }[] = [
  { href: "/calls", label: "Call Room", keywords: "cold calling dialer" },
  { href: "/calls/booked", label: "Booked Calls", keywords: "appointments" },
  { href: "/calls/callbacks", label: "Callbacks" },
  { href: "/calls/schedule", label: "Call Schedule" },
  { href: "/sequences", label: "Sequences" },
  { href: "/email", label: "Email", keywords: "compose send" },
  { href: "/automations", label: "Automations", keywords: "workflows" },
  { href: "/automations/forms", label: "Forms" },
  { href: "/automations/runs", label: "Automation Runs" },
  { href: "/automations/tasks", label: "Automation Tasks" },
];

function buildCommands(): Command[] {
  const cmds: Command[] = [];
  // Quick actions first
  cmds.push(
    { id: "act:add-contact", label: "Add contact", group: "Actions", keywords: "new contact crm create", run: () => navigate("crm") },
    { id: "act:compose-email", label: "Compose email", group: "Actions", keywords: "send new message", run: () => go("/email") },
    { id: "act:new-automation", label: "New automation", group: "Actions", keywords: "workflow create", run: () => go("/automations") },
  );
  for (const v of SHELL_VIEWS) {
    cmds.push({ id: `view:${v.id}`, label: v.label, group: v.group, keywords: v.keywords, run: () => navigate(v.id) });
  }
  for (const p of ROUTED_PAGES) {
    cmds.push({ id: `page:${p.href}`, label: p.label, group: `Page ${p.href}`, keywords: p.keywords, run: () => go(p.href) });
  }
  return cmds;
}

// ── Fuzzy match: subsequence with bonuses for prefix/word starts ─────
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  const idx = t.indexOf(q);
  if (idx === 0) return 100;
  if (idx > 0) return 60 - Math.min(idx, 30);
  // subsequence
  let ti = 0, score = 0, streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return -1;
    streak = found === ti ? streak + 1 : 1;
    score += streak + (found === 0 || t[found - 1] === " " || t[found - 1] === "/" ? 3 : 0);
    ti = found + 1;
  }
  return score;
}

const RECENTS_KEY = "wingos.palette.recents";
function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
function saveRecent(id: string) {
  try {
    const next = [id, ...loadRecents().filter(x => x !== id)].slice(0, 8);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch { /* storage blocked */ }
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const commands = useMemo(buildCommands, []);

  const openPalette = useCallback(() => {
    setRecents(loadRecents());
    setQuery("");
    setSelected(0);
    setOpen(true);
  }, []);

  // Public-path guard: the palette is mounted globally (layout.tsx), but must
  // stay inert on public/client-facing routes.
  useEffect(() => {
    const p = window.location.pathname;
    const isPublic = ["/login", "/book", "/portal", "/d"].some(
      prefix => p === prefix || p.startsWith(prefix + "/")
    );
    setEnabled(!isPublic);
  }, []);

  // Global hotkey — self-registered so mounting the component is the wiring.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(o => {
          if (!o) { setRecents(loadRecents()); setQuery(""); setSelected(0); }
          return !o;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      // No query: recents first (in order), then the full list.
      const byId = new Map(commands.map(c => [c.id, c]));
      const rec = recents.map(id => byId.get(id)).filter((c): c is Command => !!c);
      const rest = commands.filter(c => !recents.includes(c.id));
      return [...rec, ...rest];
    }
    return commands
      .map(c => ({ c, s: fuzzyScore(q, `${c.label} ${c.group} ${c.keywords ?? ""}`) }))
      .filter(r => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map(r => r.c);
  }, [query, commands, recents]);

  const recentCount = query.trim() ? 0 : results.filter(c => recents.includes(c.id)).length;

  const execute = useCallback((cmd: Command) => {
    saveRecent(cmd.id);
    setOpen(false);
    cmd.run();
  }, []);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(s => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(s => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = results[selected];
      if (cmd) execute(cmd);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Don't let Esc leak to listeners behind the palette (fullscreen
      // calendar, other modals).
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    }
  };

  // Keep the selected row visible.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Clamp selection when the result set shrinks.
  useEffect(() => {
    setSelected(s => Math.min(s, Math.max(results.length - 1, 0)));
  }, [results.length]);

  if (!enabled) return null;

  return (
    <>
      <style>{`
        .cp-overlay {
          position: fixed; inset: 0; z-index: 10010;
          background: rgba(0,0,0,0.45);
          display: flex; align-items: flex-start; justify-content: center;
          padding: 12vh 16px 16px;
        }
        .cp-panel {
          width: 100%; max-width: 560px;
          background: var(--bg-card); color: var(--text-primary);
          border: 1px solid var(--border); border-radius: 12px;
          box-shadow: 0 16px 48px rgba(0,0,0,0.35);
          overflow: hidden; display: flex; flex-direction: column;
        }
        .cp-input {
          width: 100%; padding: 14px 16px; font-size: 15px;
          background: transparent; color: var(--text-primary);
          border: none; outline: none; border-bottom: 1px solid var(--border);
          font-family: inherit;
        }
        .cp-input::placeholder { color: var(--text-muted); }
        .cp-list { max-height: 46vh; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 6px; }
        .cp-item {
          display: flex; align-items: center; gap: 10px;
          padding: 9px 10px; border-radius: 8px; cursor: pointer;
          font-size: 14px;
        }
        .cp-item[data-active="1"] { background: var(--bg-hover); }
        .cp-item .cp-group { margin-left: auto; color: var(--text-muted); font-size: 12px; }
        .cp-item[data-active="1"] .cp-label { color: var(--accent); }
        .cp-section {
          padding: 8px 10px 2px; font-size: 11px; letter-spacing: 0.06em;
          text-transform: uppercase; color: var(--text-muted);
        }
        .cp-empty { padding: 18px 14px; color: var(--text-secondary); font-size: 14px; }
        .cp-hint {
          display: flex; gap: 14px; padding: 8px 14px;
          border-top: 1px solid var(--border);
          color: var(--text-muted); font-size: 11px;
        }
        .cp-fab {
          position: fixed; right: 16px; bottom: 16px; z-index: 890;
          width: 44px; height: 44px; border-radius: 50%;
          background: var(--bg-card); color: var(--accent);
          border: 1px solid var(--border);
          box-shadow: 0 4px 16px rgba(0,0,0,0.25);
          font-size: 16px; cursor: pointer;
          display: none; align-items: center; justify-content: center;
        }
        @media (max-width: 768px) {
          /* FAB: just above the MobileNav bottom tab bar. The Jarvis FAB is
             display:none on mobile, so nothing else occupies this corner. */
          .cp-fab {
            display: flex;
            right: 16px;
            bottom: calc(76px + env(safe-area-inset-bottom, 0px));
          }
          /* Near-fullscreen sheet on phone instead of a tiny centered box. */
          .cp-overlay {
            padding: calc(env(safe-area-inset-top, 0px) + 10px) 10px
                     calc(env(safe-area-inset-bottom, 0px) + 10px);
            align-items: stretch;
          }
          .cp-panel { max-width: none; height: 100%; }
          /* 16px input font prevents iOS auto-zoom on focus. */
          .cp-input { font-size: 16px; padding: 15px 16px; }
          .cp-list { max-height: none; flex: 1 1 auto; }
          /* Touch-sized rows (>= 44px). */
          .cp-item { padding: 12px 10px; min-height: 44px; }
          /* Keyboard hints are meaningless on touch. */
          .cp-hint { display: none; }
        }
      `}</style>

      {!open && (
        <button className="cp-fab" aria-label="Open command palette" onClick={openPalette}>
          ⌘
        </button>
      )}

      {open && (
        <div className="cp-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="cp-panel" role="dialog" aria-label="Command palette">
            <input
              ref={inputRef}
              className="cp-input"
              placeholder="Jump to a view, page, or action…"
              value={query}
              onChange={e => { setQuery(e.target.value); setSelected(0); }}
              onKeyDown={onInputKey}
              spellCheck={false}
            />
            <div className="cp-list" ref={listRef}>
              {results.length === 0 && <div className="cp-empty">No matches.</div>}
              {results.map((cmd, i) => (
                <div key={cmd.id}>
                  {recentCount > 0 && i === 0 && <div className="cp-section">Recent</div>}
                  {recentCount > 0 && i === recentCount && <div className="cp-section">Everything</div>}
                  <div
                    className="cp-item"
                    data-idx={i}
                    data-active={i === selected ? "1" : "0"}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => execute(cmd)}
                  >
                    <span className="cp-label">{cmd.label}</span>
                    <span className="cp-group">{cmd.group}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="cp-hint">
              <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
