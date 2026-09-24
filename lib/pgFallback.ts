// Direct-Postgres fallback for the PostgREST calls the Call Room makes.
//
// Why this exists: on 2026-09-21 Supabase restricted the account for exceeding
// its storage quota, and from then on EVERY REST call answers HTTP 402 while the
// data itself sits untouched in Postgres. The connection pooler keeps working
// through that restriction, so when REST says 402 the call-room helpers replay
// the same query here, over OS_DB_URL, and the room keeps running.
//
// It translates only the PostgREST subset the call room actually uses:
//   select=a,b,embed(c,d)   eq neq gt gte lt lte like ilike is in, not.<op>
//   or=(x.op.v,y.op.v)      order=a.desc,b.asc   limit  offset
// Anything it does not understand throws, so a query is never half-translated
// into something broader than what was asked.
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
let client: Sql | null = null;

export function pgConfigured(): boolean {
  return Boolean(process.env.OS_DB_URL);
}

function db(): Sql {
  if (!client) {
    // Port 6543 is the transaction pooler: no prepared statements there.
    client = postgres(process.env.OS_DB_URL as string, {
      prepare: false,
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return client;
}

// A child table's embedded parent, keyed child -> parent -> foreign key column.
const EMBEDS: Record<string, Record<string, string>> = {
  call_activity: { call_leads: "lead_id" },
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`pgFallback: unsafe identifier "${name}"`);
  return `"${name}"`;
}

// Split on commas that are not inside parentheses.
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

class Params {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

// One condition: column, then "op.value" (optionally "not.op.value").
function condition(col: string, expr: string, p: Params): string {
  const c = ident(col);
  let negate = false;
  if (expr.startsWith("not.")) {
    negate = true;
    expr = expr.slice(4);
  }
  const dot = expr.indexOf(".");
  if (dot < 0) throw new Error(`pgFallback: bad filter "${col}=${expr}"`);
  const op = expr.slice(0, dot);
  const val = expr.slice(dot + 1);
  let sql: string;
  switch (op) {
    case "eq": sql = `${c}::text = ${p.add(val)}`; break;
    case "neq": sql = `${c}::text <> ${p.add(val)}`; break;
    case "gt": sql = `${c} > ${p.add(val)}`; break;
    case "gte": sql = `${c} >= ${p.add(val)}`; break;
    case "lt": sql = `${c} < ${p.add(val)}`; break;
    case "lte": sql = `${c} <= ${p.add(val)}`; break;
    case "like": sql = `${c}::text like ${p.add(val.replace(/\*/g, "%"))}`; break;
    case "ilike": sql = `${c}::text ilike ${p.add(val.replace(/\*/g, "%"))}`; break;
    case "is": {
      const v = val.toLowerCase();
      if (!["null", "true", "false"].includes(v)) throw new Error(`pgFallback: bad is.${val}`);
      sql = `${c} is ${v}`;
      break;
    }
    case "in": {
      const inner = val.replace(/^\(/, "").replace(/\)$/, "");
      const items = splitTop(inner).map((x) => x.trim().replace(/^"|"$/g, ""));
      sql = items.length ? `${c}::text in (${items.map((x) => p.add(x)).join(",")})` : "false";
      break;
    }
    default:
      throw new Error(`pgFallback: unsupported operator "${op}"`);
  }
  return negate ? `not (${sql})` : sql;
}

// "a.eq.1,b.is.null" inside or=( ... )
function orGroup(val: string, p: Params): string {
  const inner = val.replace(/^\(/, "").replace(/\)$/, "");
  const parts = splitTop(inner).map((part) => {
    const dot = part.indexOf(".");
    return condition(part.slice(0, dot), part.slice(dot + 1), p);
  });
  return `(${parts.join(" or ")})`;
}

type Parsed = {
  select: string;
  where: string[];
  order: string;
  limit: string;
  offset: string;
};

function parse(table: string, qs: string, p: Params): Parsed {
  const out: Parsed = { select: "*", where: [], order: "", limit: "", offset: "" };
  const t = ident(table);
  for (const pair of qs.split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const key = decodeURIComponent(pair.slice(0, eq));
    const val = decodeURIComponent(pair.slice(eq + 1));
    if (key === "select") {
      out.select = splitTop(val)
        .map((col) => {
          col = col.trim();
          if (col === "*") return `${t}.*`;
          const m = col.match(/^([a-z_][a-z0-9_]*)\((.*)\)$/);
          if (m) {
            const fk = EMBEDS[table]?.[m[1]];
            if (!fk) throw new Error(`pgFallback: unknown embed ${m[1]}`);
            const cols = m[2] === "*" ? "*" : splitTop(m[2]).map((x) => ident(x.trim())).join(",");
            return `(select row_to_json(e) from (select ${cols} from ${ident(m[1])} where id = ${t}.${ident(fk)}) e) as ${ident(m[1])}`;
          }
          return `${t}.${ident(col)}`;
        })
        .join(", ");
    } else if (key === "order") {
      out.order =
        " order by " +
        val
          .split(",")
          .map((o) => {
            const [col, dir, nulls] = o.split(".");
            const d = dir === "desc" ? "desc" : "asc";
            const n = nulls === "nullsfirst" ? " nulls first" : nulls === "nullslast" ? " nulls last" : "";
            return `${ident(col)} ${d}${n}`;
          })
          .join(", ");
    } else if (key === "limit") {
      out.limit = ` limit ${Math.max(0, Math.trunc(Number(val)) || 0)}`;
    } else if (key === "offset") {
      out.offset = ` offset ${Math.max(0, Math.trunc(Number(val)) || 0)}`;
    } else if (key === "or") {
      out.where.push(orGroup(val, p));
    } else {
      out.where.push(condition(key, val, p));
    }
  }
  return out;
}

const where = (w: string[]) => (w.length ? ` where ${w.join(" and ")}` : "");

// json_agg keeps the exact JSON shapes PostgREST returns (numbers as numbers,
// timestamps as ISO strings), so callers cannot tell which path answered.
async function jsonRows<T>(inner: string, values: unknown[]): Promise<T[]> {
  const rows = await db().unsafe(
    `select coalesce(json_agg(t), '[]'::json) as rows from (${inner}) t`,
    values as never[]
  );
  return (rows[0]?.rows ?? []) as T[];
}

// A data-modifying CTE must sit at the top level, so writes aggregate from it
// directly instead of going through jsonRows' subquery.
async function writeRows<T>(cte: string, values: unknown[]): Promise<T[]> {
  const rows = await db().unsafe(
    `${cte} select coalesce(json_agg(w), '[]'::json) as rows from w`,
    values as never[]
  );
  return (rows[0]?.rows ?? []) as T[];
}

export async function pgSelect<T = unknown>(table: string, qs: string): Promise<T[]> {
  const p = new Params();
  const q = parse(table, qs, p);
  return jsonRows<T>(
    `select ${q.select} from ${ident(table)}${where(q.where)}${q.order}${q.limit}${q.offset}`,
    p.values
  );
}

export async function pgCount(table: string, qs: string): Promise<number> {
  const p = new Params();
  const q = parse(table, qs, p);
  const rows = await db().unsafe(
    `select count(*)::int as n from ${ident(table)}${where(q.where)}`,
    p.values as never[]
  );
  return Number(rows[0]?.n ?? 0);
}

function literal(v: unknown): unknown {
  return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
}

export async function pgPatch<T = unknown>(
  table: string,
  filter: string,
  patch: Record<string, unknown>
): Promise<T[]> {
  const p = new Params();
  const sets = Object.entries(patch).map(([k, v]) => `${ident(k)} = ${p.add(literal(v))}`);
  const q = parse(table, filter, p);
  if (!q.where.length) throw new Error("pgFallback: refusing an unfiltered update");
  return writeRows<T>(
    `with w as (update ${ident(table)} set ${sets.join(", ")}${where(q.where)} returning *)`,
    p.values
  );
}

export async function pgInsert<T = unknown>(table: string, body: unknown): Promise<T[]> {
  const rows = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const p = new Params();
  const tuples = rows.map((r) => `(${cols.map((c) => p.add(literal(r[c]))).join(", ")})`);
  return writeRows<T>(
    `with w as (insert into ${ident(table)} (${cols.map(ident).join(", ")}) values ${tuples.join(", ")} returning *)`,
    p.values
  );
}

export async function pgColumnExists(table: string, column: string): Promise<boolean> {
  const rows = await db().unsafe(
    "select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2",
    [table, column]
  );
  return rows.length > 0;
}
