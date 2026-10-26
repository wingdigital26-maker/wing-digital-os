import { currentUser } from "@/lib/command/auth";
import { loadClients } from "@/lib/command/clients";
import { listProblems } from "@/lib/command/problems";
import { ago } from "@/lib/command/time";
import { Empty, Problems } from "../../_ui/bits";
import DigestButton from "../../_ui/DigestButton";
import ProblemCard from "../../_ui/ProblemCard";
import ReportProblem from "../../_ui/ReportProblem";

export const dynamic = "force-dynamic";

// Problems: anyone reports one, everyone gets a text. Open > Working > Fixed.
export default async function ProblemsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const show = (await searchParams).show;
  const [user, { clients, errors }, list] = await Promise.all([currentUser(), loadClients(), listProblems()]);
  const names = new Map(clients.map((c) => [c.slug, c.name]));
  const all = list.ok ? list.data : [];
  const open = all.filter((p) => p.status !== "fixed");
  const fixed = all.filter((p) => p.status === "fixed");
  const card = (p: (typeof all)[number]) => (
    <ProblemCard
      key={p.id}
      me={user!.id}
      p={{
        id: p.id, client: p.client_slug ? names.get(p.client_slug) ?? p.client_slug : "Wing", reported_by: p.reported_by,
        urgency: p.urgency, body: p.body, has_screenshot: p.has_screenshot, status: p.status, owner: p.owner,
        source: p.source, created: ago(p.created_at), comments: p.comments ?? 0,
      }}
    />
  );

  return (
    <>
      <h1 className="cc-h1">Problems</h1>
      <p className="cc-lede">Anything broken or any client unhappy goes here. Saving one texts Jack, Grant and Dylan.</p>
      <Problems errors={[...errors, list.ok ? null : list.reason]} />
      <ReportProblem clients={clients.map((c) => ({ slug: c.slug, name: c.name }))} />

      <h2 className="cc-h2">Open <span className="cc-count">{open.length}</span></h2>
      {open.length ? <div className="cc-grid two">{open.map(card)}</div> : <Empty>Nothing open.</Empty>}

      {user?.admin ? <DigestButton /> : null}

      <h2 className="cc-h2">Fixed <span className="cc-count">{fixed.length}</span>{show !== "fixed" && fixed.length ? <a href="?show=fixed">Show</a> : null}</h2>
      {show === "fixed" ? (fixed.length ? <div className="cc-grid two">{fixed.map(card)}</div> : <Empty>Nothing fixed yet.</Empty>) : null}
    </>
  );
}
