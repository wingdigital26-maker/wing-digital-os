import BackToOs from "../components/BackToOs";
import { getRoofOverview, type RoofClient } from "@/lib/roofCommand";
import "./roof-command.css";

// /roof-command: the OS view of the separate Roof Command project. Server
// component on purpose: the data is read server-side (lib/roofCommand.ts) with
// the Roof Command service key, so the key never reaches the browser and the
// page ships plain HTML. Read-only: nothing on this page writes anywhere.
// The same data is available as JSON at /api/roof-command.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Roof Command",
  description: "Storm coverage and roofer accounts from Roof Command, read-only.",
};

const APP_URL = "http://localhost:4841";

const n = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "unknown" : v.toLocaleString("en-US");

function fmtDay(iso: string): string {
  // Storm dates are plain calendar days; read them as UTC so they never shift.
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "No activity yet";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  });
}

function floorText(c: RoofClient): string {
  if (c.pilotFloor == null) return "No floor set";
  if (c.booked == null) return `Floor ${c.pilotFloor}`;
  return `${c.booked} of ${c.pilotFloor} booked`;
}

function ClientTable({ rows }: { rows: RoofClient[] }) {
  return (
    <div className="rc-tablewrap">
      <table className="rc-table">
        <thead>
          <tr>
            <th>Roofer</th>
            <th>Plan</th>
            <th className="num">Counties</th>
            <th className="num">Queued today</th>
            <th className="num">Calls, 7 days</th>
            <th className="num">Booked, 7 days</th>
            <th>Inspections this month</th>
            <th>Pilot floor</th>
            <th>Last activity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => (
            <tr key={c.name}>
              <td><span className="rc-co">{c.name}</span></td>
              <td>
                <span className="rc-badge">{c.plan || "No plan"}</span>
                {c.status && c.status !== "active" ? <span className="rc-badge rc-badge-warn">{c.status}</span> : null}
              </td>
              <td className="num">{n(c.counties)}</td>
              <td className="num">{n(c.queuedToday)}</td>
              <td className="num">{n(c.callAttempts7d)}</td>
              <td className="num">{n(c.bookedFromCalls7d)}</td>
              <td>
                <span className="rc-funnel">
                  {n(c.booked)} booked <span className="rc-sep">/</span> {n(c.shown)} shown <span className="rc-sep">/</span> {n(c.signed)} signed
                </span>
                {c.jobValue ? <span className="rc-sub">${c.jobValue.toLocaleString("en-US")} signed</span> : null}
              </td>
              <td>{floorText(c)}</td>
              <td className="rc-when">{fmtWhen(c.lastActivity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function RoofCommandPage() {
  const data = await getRoofOverview();

  return (
    <div className="rc-page page-scroll">
      <div className="rc-wrap">
        <BackToOs style={{ marginBottom: 16 }} />
        <header className="rc-head">
          <h1>Roof Command</h1>
          <p>
            Storm coverage and roofer accounts from the Roof Command app. Read-only: nothing on this page
            changes Roof Command data.
          </p>
        </header>

        {!data.connected ? (
          <div className="rc-note">
            <strong>Roof Command is not connected yet.</strong> Once its database keys are added to this
            deployment, coverage and roofer accounts show here.
          </div>
        ) : !data.ok ? (
          <div className="rc-note rc-note-err">
            <strong>Could not load Roof Command right now.</strong> {data.error} Refresh in a minute.
          </div>
        ) : (
          <>
            <section className="rc-section">
              <h2>Coverage</h2>
              <p className="rc-subline">Every home Roof Command watches for hail, and the storms that hit them.</p>
              <div className="rc-stats">
                <div className="rc-stat">
                  <div className="rc-stat-l">Homes watched</div>
                  <div className="rc-stat-n">{n(data.coverage.homesWatched)}</div>
                  <div className="rc-stat-s">Across {data.coverage.countiesLive} {data.coverage.countiesLive === 1 ? "county" : "counties"}</div>
                </div>
                <div className="rc-stat">
                  <div className="rc-stat-l">Counties live</div>
                  <div className="rc-stat-n">{data.coverage.countiesLive}</div>
                  <div className="rc-stat-s">{data.coverage.counties.map(c => c.replace(/ County$/, "")).join(", ")}</div>
                </div>
                <div className="rc-stat">
                  <div className="rc-stat-l">Latest storm</div>
                  {data.coverage.latestStorm ? (
                    <>
                      <div className="rc-stat-n">{fmtDay(data.coverage.latestStorm.date)}</div>
                      <div className="rc-stat-s">
                        {n(data.coverage.latestStorm.homes1in)} homes at 1 in or more
                        {data.coverage.latestStorm.maxHailIn != null ? `, max hail ${data.coverage.latestStorm.maxHailIn.toFixed(2)} in` : ""}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="rc-stat-n">None yet</div>
                      <div className="rc-stat-s">No storms recorded in these counties</div>
                    </>
                  )}
                </div>
                <div className="rc-stat">
                  <div className="rc-stat-l">Storms this season</div>
                  <div className="rc-stat-n">{n(data.coverage.stormsThisSeason)}</div>
                  <div className="rc-stat-s">Hail days in {data.coverage.seasonYear}</div>
                </div>
              </div>
            </section>

            <section className="rc-section">
              <h2>Roofer clients</h2>
              <p className="rc-subline">
                One row per roofer account. Daily 50 numbers cover the last 7 days; inspections count from{" "}
                {fmtDay(data.monthStart)}.
              </p>
              {(() => {
                const real = data.clients.filter(c => !c.isTest);
                const tests = data.clients.filter(c => c.isTest);
                return (
                  <>
                    {real.length ? (
                      <ClientTable rows={real} />
                    ) : (
                      <div className="rc-empty">
                        No roofer accounts yet. The first pilot roofer appears here once signed up.
                      </div>
                    )}
                    {tests.length ? (
                      <div className="rc-tests">
                        <h3>Test accounts</h3>
                        <p className="rc-subline">Internal test logins, not paying roofers.</p>
                        <ClientTable rows={tests} />
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </section>
          </>
        )}

        <section className="rc-section">
          <h2>Links</h2>
          <div className="rc-links">
            <a className="rc-link" href={APP_URL} target="_blank" rel="noreferrer">
              <span className="rc-link-t">Open the Roof Command app <span className="rc-badge">Local</span></span>
              <span className="rc-link-s">Runs on the office PC at localhost:4841 until it is hosted.</span>
            </a>
            <div className="rc-link rc-link-static">
              <span className="rc-link-t">System map</span>
              <span className="rc-link-s">Lives in the Roof Command repo as docs/system-map.html. Open it on the office PC.</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
