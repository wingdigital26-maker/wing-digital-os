import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { loadClients } from "@/lib/command/clients";
import { withStore } from "@/lib/command/db";
import { personName } from "@/lib/command/team";
import { ago, fmtWhen, money } from "@/lib/command/time";
import { clientPage } from "@/lib/command/vault";
import { Empty, HealthTag, Problems } from "../../../_ui/bits";
import ClientEditor from "../../../_ui/ClientEditor";
import ReportProblem from "../../../_ui/ReportProblem";

export const dynamic = "force-dynamic";

type Hist = { at: string; kind: string; text: string; tone?: string };

export default async function ClientDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { clients, errors } = await loadClients();
  const c = clients.find((x) => x.slug === slug);
  if (!c) notFound();

  const [store, page] = await Promise.all([
    withStore(async (sql) => {
      const [meta, checks, touches, problems] = await Promise.all([
        sql<{ plan: string | null; mrr: string | null; crm_url: string | null; next_action: string | null; is_roofer: boolean | null; roofer_contact: string | null; roofer_phone: string | null }[]>`
          select plan, mrr, crm_url, next_action, is_roofer, roofer_contact, roofer_phone from cc_client_meta where slug = ${slug}`,
        sql<{ color: string; checked_at: string | null; stale: boolean; summary: string | null; recorded_at: string }[]>`
          select color, checked_at::text, stale, summary, recorded_at::text from cc_checks where client_slug = ${slug} order by recorded_at desc limit 30`,
        sql<{ channel: string; mood: string; problems: string | null; note: string | null; by_user: string; created_at: string }[]>`
          select channel, mood, problems, note, by_user, created_at::text from cc_roofer_touches where client_slug = ${slug} order by created_at desc limit 30`,
        sql<{ id: number; body: string; status: string; urgency: string; created_at: string; fixed_at: string | null }[]>`
          select id::int, body, status, urgency, created_at::text, fixed_at::text from cc_problems where client_slug = ${slug} order by created_at desc limit 30`,
      ]);
      return { meta: meta[0] ?? null, checks, touches, problems };
    }),
    c.from.includes("vault") ? clientPage(slug) : Promise.resolve(null),
  ]);
  const s = store.ok ? store.data : null;

  const hist: Hist[] = [];
  for (const k of s?.checks ?? []) hist.push({ at: k.recorded_at, kind: "Daily check", text: `${k.color}${k.stale ? " (stale)" : ""}${k.summary ? `: ${k.summary}` : ""}`, tone: k.color });
  for (const t of s?.touches ?? []) hist.push({ at: t.created_at, kind: `Check-in (${t.channel})`, text: `${personName(t.by_user)}: ${t.mood}${t.problems ? `. Problem: ${t.problems}` : ""}${t.note ? `. ${t.note}` : ""}`, tone: t.mood === "unhappy" ? "red" : undefined });
  for (const p of s?.problems ?? []) hist.push({ at: p.created_at, kind: "Problem", text: `#${p.id} ${p.body} (${p.status})`, tone: p.status === "fixed" ? "green" : "red" });
  hist.sort((a, b) => (a.at < b.at ? 1 : -1));

  const body = page?.replace(/^---[\s\S]*?---/, "").slice(0, 6000);

  return (
    <>
      <p><Link href="/command/clients">All clients</Link></p>
      <div className="cc-spread">
        <h1 className="cc-h1">{c.name}</h1>
        <HealthTag h={c.health} />
      </div>
      <p className="cc-lede">
        {[c.industry, c.location].filter(Boolean).join(", ") || "Client"}. Last automated check: {c.checkedAt ? `${fmtWhen(c.checkedAt)} (${ago(c.checkedAt)})` : "none on file"}.
      </p>
      <Problems errors={[...errors, store.ok ? null : store.reason]} />
      {c.atRisk.length ? <div className="cc-note err"><strong>At risk.</strong> {c.atRisk.join(". ")}.</div> : null}

      <div className="cc-grid three">
        <div className="cc-card"><div className="cc-muted">MRR</div><strong>{c.mrr != null ? `${money(c.mrr)}/mo` : c.mrrNote ?? "Not recorded"}</strong></div>
        <div className="cc-card"><div className="cc-muted">Plan</div><strong>{c.plan ?? "Not recorded"}</strong></div>
        <div className="cc-card"><div className="cc-muted">Billing</div><strong>{c.billing ? `${c.billing.status}${c.billing.amount ? `, ${money(c.billing.amount)}` : ""}` : "Not recorded"}</strong></div>
      </div>

      <div className="cc-row" style={{ margin: "14px 0" }}>
        {c.contactPhone ? <a className="cc-btn cc-call" href={`tel:${c.contactPhone.replace(/[^\d+]/g, "")}`}>Call {c.contactName ?? "client"}</a> : null}
        {c.crmUrl ? <a className="cc-btn" href={c.crmUrl} target="_blank" rel="noreferrer">CRM / app</a> : null}
        {c.liveSite ? <a className="cc-btn" href={c.liveSite} target="_blank" rel="noreferrer">Live site</a> : null}
        <Link className="cc-btn" href={`/command/seo#${c.slug}`}>SEO posts</Link>
        {c.isRoofer ? <Link className="cc-btn" href="/command/roofers">Log check-in</Link> : null}
      </div>

      {c.healthPage ? (
        <>
          <h2 className="cc-h2">Latest automated check</h2>
          <div className={`cc-card edge-${c.health}`}>
            {c.healthPage.reds.length ? (<><strong>Act today</strong><ul className="cc-list">{c.healthPage.reds.map((r) => <li key={r}>{r}</li>)}</ul></>) : <p className="cc-sub">No red flags.</p>}
            {c.healthPage.yellows.length ? (<><strong>Worth knowing</strong><ul className="cc-list">{c.healthPage.yellows.map((r) => <li key={r}>{r}</li>)}</ul></>) : null}
            {c.healthPage.published ? <p className="cc-sub"><strong>Published since last run:</strong> {c.healthPage.published}</p> : null}
          </div>
        </>
      ) : null}

      <h2 className="cc-h2">Edit</h2>
      {s ? (
        <ClientEditor
          slug={c.slug}
          name={c.name}
          meta={{
            plan: s.meta?.plan ?? null,
            mrr: s.meta?.mrr != null ? Number(s.meta.mrr) : null,
            crm_url: s.meta?.crm_url ?? null,
            next_action: s.meta?.next_action ?? null,
            is_roofer: s.meta?.is_roofer ?? c.isRoofer,
            roofer_contact: s.meta?.roofer_contact ?? null,
            roofer_phone: s.meta?.roofer_phone ?? null,
          }}
          billing={c.billing ? { status: c.billing.status, amount: c.billing.amount, due_date: c.billing.due_date, note: c.billing.note } : null}
        />
      ) : <Empty>Editing needs storage. See Setup.</Empty>}

      <h2 className="cc-h2">Report a problem for {c.name}</h2>
      <ReportProblem clients={[{ slug: c.slug, name: c.name }]} fixedClient={c.slug} />

      <h2 className="cc-h2">History <span className="cc-count">{hist.length}</span></h2>
      {hist.length ? (
        <div className="cc-card">
          <ul className="cc-list">
            {hist.map((h, i) => (
              <li key={i}>
                <div className="cc-row"><span className={`cc-tag ${h.tone ?? ""}`}>{h.kind}</span><span className="cc-muted">{fmtWhen(h.at)}</span></div>
                {h.text}
              </li>
            ))}
          </ul>
        </div>
      ) : <Empty>No history yet. Daily checks, check-ins and problems collect here.</Empty>}

      {body ? (
        <details className="cc-more-info" style={{ marginTop: 18 }}>
          <summary>Vault notes ({c.slug}.md)</summary>
          <div className="cc-card cc-prose"><ReactMarkdown>{body}</ReactMarkdown></div>
        </details>
      ) : null}
    </>
  );
}
