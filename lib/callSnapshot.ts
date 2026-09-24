// Last-resort READ source for the Call Room: a JSON copy of call_leads and
// call_activity shipped with the deploy (data/callroom-snapshot.json, taken
// over the pooler by scripts/snapshot_callroom.py and kept out of git because
// it holds contact details).
//
// Order of preference in _guard.ts: Supabase REST, then direct Postgres
// (OS_DB_URL), then this. It only ever answers reads, so the dial list is never
// empty while the live database is unreachable. Writes are not faked here.
import { readFileSync } from "fs";
import path from "path";

type Row = Record<string, unknown>;
type Snapshot = { _taken_at?: string } & Record<string, Row[]>;

let cache: Snapshot | null | undefined;

function load(): Snapshot | null {
  if (cache !== undefined) return cache;
  try {
    cache = JSON.parse(
      readFileSync(path.join(process.cwd(), "data", "callroom-snapshot.json"), "utf8")
    ) as Snapshot;
  } catch {
    cache = null;
  }
  return cache;
}

export function snapshotHas(table: string): boolean {
  const s = load();
  return Boolean(s && Array.isArray(s[table]));
}

export function snapshotTakenAt(): string | null {
  return load()?._taken_at ?? null;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

type Pred = (r: Row) => boolean;

function likeRe(pat: string): RegExp {
  const esc = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/%/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

function cmp(a: unknown, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a !== null && a !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  const ta = Date.parse(String(a));
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return String(a ?? "").localeCompare(b);
}

function condition(col: string, expr: string): Pred {
  let negate = false;
  if (expr.startsWith("not.")) {
    negate = true;
    expr = expr.slice(4);
  }
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const val = expr.slice(dot + 1);
  let p: Pred;
  switch (op) {
    case "eq": p = (r) => r[col] !== null && r[col] !== undefined && String(r[col]) === val; break;
    case "neq": p = (r) => r[col] !== null && r[col] !== undefined && String(r[col]) !== val; break;
    case "gt": p = (r) => r[col] != null && cmp(r[col], val) > 0; break;
    case "gte": p = (r) => r[col] != null && cmp(r[col], val) >= 0; break;
    case "lt": p = (r) => r[col] != null && cmp(r[col], val) < 0; break;
    case "lte": p = (r) => r[col] != null && cmp(r[col], val) <= 0; break;
    case "like":
    case "ilike": {
      const re = likeRe(val);
      p = (r) => r[col] != null && re.test(String(r[col]));
      break;
    }
    case "is": {
      const v = val.toLowerCase();
      p = v === "null" ? (r) => r[col] == null : (r) => r[col] === (v === "true");
      break;
    }
    case "in": {
      const items = new Set(
        splitTop(val.replace(/^\(/, "").replace(/\)$/, "")).map((x) => x.trim().replace(/^"|"$/g, ""))
      );
      p = (r) => r[col] != null && items.has(String(r[col]));
      break;
    }
    default:
      throw new Error(`callSnapshot: unsupported operator "${op}"`);
  }
  return negate ? (r) => !p(r) : p;
}

function query(table: string, qs: string) {
  const s = load();
  if (!s || !Array.isArray(s[table])) throw new Error(`callSnapshot: no ${table}`);
  const preds: Pred[] = [];
  let select: string[] | null = null;
  let embeds: { name: string; cols: string[] }[] = [];
  let order: { col: string; desc: boolean }[] = [];
  let limit = Infinity;
  let offset = 0;
  for (const pair of qs.split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const key = decodeURIComponent(pair.slice(0, eq));
    const val = decodeURIComponent(pair.slice(eq + 1));
    if (key === "select") {
      const cols = splitTop(val).map((c) => c.trim());
      if (!cols.includes("*")) select = cols.filter((c) => !c.includes("("));
      embeds = cols
        .map((c) => c.match(/^([a-z_]+)\((.*)\)$/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .map((m) => ({ name: m[1], cols: splitTop(m[2]).map((x) => x.trim()) }));
    } else if (key === "order") {
      order = val.split(",").map((o) => {
        const [col, dir] = o.split(".");
        return { col, desc: dir === "desc" };
      });
    } else if (key === "limit") limit = Number(val) || 0;
    else if (key === "offset") offset = Number(val) || 0;
    else if (key === "or") {
      const parts = splitTop(val.replace(/^\(/, "").replace(/\)$/, "")).map((part) => {
        const dot = part.indexOf(".");
        return condition(part.slice(0, dot), part.slice(dot + 1));
      });
      preds.push((r) => parts.some((p) => p(r)));
    } else preds.push(condition(key, val));
  }
  let rows = s[table].filter((r) => preds.every((p) => p(r)));
  const total = rows.length;
  if (order.length) {
    rows = [...rows].sort((a, b) => {
      for (const o of order) {
        const av = a[o.col];
        const bv = b[o.col];
        if (av == null && bv == null) continue;
        // Postgres puts NULLs last ascending and first descending.
        if (av == null) return o.desc ? -1 : 1;
        if (bv == null) return o.desc ? 1 : -1;
        const c = cmp(av, String(bv));
        if (c !== 0) return o.desc ? -c : c;
      }
      return 0;
    });
  }
  rows = rows.slice(offset, offset + limit);
  const leads = s.call_leads ?? [];
  const shaped = rows.map((r) => {
    const o: Row = select ? Object.fromEntries(select.map((c) => [c, r[c] ?? null])) : { ...r };
    for (const e of embeds) {
      if (e.name === "call_leads") {
        const parent = leads.find((l) => l.id === r.lead_id);
        o.call_leads = parent ? Object.fromEntries(e.cols.map((c) => [c, parent[c] ?? null])) : null;
      }
    }
    return o;
  });
  return { rows: shaped, total };
}

export function snapshotSelect<T = unknown>(table: string, qs: string): T[] {
  return query(table, qs).rows as T[];
}

export function snapshotCount(table: string, qs: string): number {
  return query(table, qs.replace(/(^|&)(limit|offset)=[^&]*/g, "")).total;
}

export function snapshotColumnExists(table: string, column: string): boolean {
  const rows = load()?.[table];
  return Boolean(rows?.length && column in rows[0]);
}
