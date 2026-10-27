import Link from "next/link";
import { currentUser } from "@/lib/command/auth";
import { currentChecks } from "@/lib/command/checks";
import { ago, fmtWhen } from "@/lib/command/time";
import { STALE_HOURS } from "@/lib/command/vault";
import { Empty, HealthTag, Problems } from "../../_ui/bits";
import RunCheck from "../../_ui/RunCheck";

export const dynamic = "force-dynamic";

// Daily client check: the latest automated (sentinel) check per client.
export default async function ChecksPage() {
  const [{ rows, sentinel, errors }, user] = await Promise.all([currentChecks(), currentUser()]);
  const flagged = rows.filter((r) => r.missing || r.stale);
  return (
    <>
      <h1 className="cc-h1">Daily client checks</h1>
      <p className="cc-lede">
        The sentinel agent checks every client each morning and writes a health page to the vault. This screen reads those pages.
        A check that is missing or more than {STALE_HOURS} hours old is flagged.
      </p>
      <Problems errors={errors} />
      {sentinel ? <div className="cc-note ok">{sentinel}</div> : <div className="cc-note">Could not read the sentinel health board.</div>}
      {flagged.length ? (
        <div className="cc-note err"><strong>{flagged.length} client{flagged.length === 1 ? "" : "s"} without a fresh check:</strong> {flagged.map((f) => f.name).join(", ")}.</div>
      ) : null}
      {user?.admin ? <RunCheck /> : null}
      <div className="cc-grid two" style={{ marginTop: 14 }}>
        {rows.map((r) => (
          <div key={r.slug} className={`cc-card edge-${r.missing ? "unknown" : r.color}`}>
            <div className="cc-spread">
              <h3><Link href={`/command/clients/${r.slug}`}>{r.name}</Link></h3>
              <HealthTag h={r.missing ? "unknown" : r.color} />
            </div>
            <div className="cc-sub">
              {r.missing ? "No automated check on file. Add a Sentinel Config to this client's vault page." : `Last checked ${fmtWhen(r.checkedAt)} (${ago(r.checkedAt)})`}
            </div>
            {!r.missing && r.stale ? <div className="cc-row" style={{ marginTop: 6 }}><span className="cc-tag red">Stale: over {STALE_HOURS}h</span></div> : null}
            {r.reds.length ? <ul className="cc-list" style={{ marginTop: 8 }}>{r.reds.map((x) => <li key={x}><strong>Red:</strong> {x}</li>)}</ul> : null}
            {r.yellows.length ? <ul className="cc-list">{r.yellows.map((x) => <li key={x}><strong>Yellow:</strong> {x}</li>)}</ul> : null}
            {r.published ? <p className="cc-muted">Published since last run: {r.published}</p> : null}
          </div>
        ))}
      </div>
      {!rows.length ? <Empty>No clients found in the vault.</Empty> : null}
    </>
  );
}
