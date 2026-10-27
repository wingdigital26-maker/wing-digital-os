import { redirect } from "next/navigation";
import { currentUser } from "@/lib/command/auth";
import { osSupabaseProbe, setupStatus } from "@/lib/command/setup";

export const dynamic = "force-dynamic";

function Row({ ok, label, children }: { ok: boolean; label: string; children: React.ReactNode }) {
  return (
    <li>
      <div className="cc-row"><span className={`cc-tag ${ok ? "green" : "yellow"}`}>{ok ? "Set" : "To do"}</span><strong>{label}</strong></div>
      <div className="cc-sub">{children}</div>
    </li>
  );
}

// Setup (Jack only): what is wired on this deployment and exactly what is left.
// Shows yes/no only; no value is ever printed.
export default async function SetupPage() {
  const user = await currentUser();
  if (!user?.admin) redirect("/command");
  const [s, probe] = await Promise.all([setupStatus(), osSupabaseProbe()]);
  const n = s.notify;

  return (
    <>
      <h1 className="cc-h1">Setup</h1>
      <p className="cc-lede">What this deployment has, and what Jack still needs to add in Vercel (Project, Settings, Environment Variables). Full steps are in docs/COMMAND_CENTER.md.</p>
      <div className="cc-card">
        <ul className="cc-list">
          <Row ok={s.store === "ok"} label="Storage (COMMAND_DB_URL)">
            {s.store === "ok" ? "Connected. Tables are created automatically." : s.store === "off" ? "Not set. Create a free Postgres (a new Supabase project in its own org, or Vercel Postgres) and paste its connection string." : s.store}
          </Row>
          <Row ok={s.sessionSecret && Object.values(s.codes).every(Boolean)} label="Sign-in codes">
            AUTH_SESSION_SECRET {s.sessionSecret ? "set" : "missing"}. Codes: {Object.entries(s.codes).map(([u, ok]) => `${u} ${ok ? "set" : "missing"}`).join(", ")} (COMMAND_CODE_JACK, COMMAND_CODE_GRANT, COMMAND_CODE_DYLAN, 6 characters or more).
          </Row>
          <Row ok={n.twilio && Object.values(n.phones).every(Boolean)} label="Team texts (Twilio)">
            Twilio {n.twilio ? "set" : "not set"} (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM). Phones: {Object.entries(n.phones).map(([u, ok]) => `${u} ${ok ? "set" : "missing"}`).join(", ")} (COMMAND_PHONE_JACK and so on, as +1XXXXXXXXXX).
          </Row>
          <Row ok={n.ntfy || n.email} label="Free backup alerts (ntfy or email)">
            ntfy {n.ntfy ? "set" : "not set"} (COMMAND_NTFY_TOPIC). Email {n.email ? "set" : "not set"} (COMMAND_EMAIL_JACK and so on, sent through the OS SMTP mailbox).
          </Row>
          <Row ok={s.machineKey} label="Daily routine key (COMMAND_MACHINE_KEY)">
            Lets the daily routine, the laptop sync and the content agents call in. 16 characters or more.
          </Row>
          <Row ok={s.calendar.id} label="Shared calendar (COMMAND_CALENDAR_ID)">
            {s.calendar.id ? "Calendar connected." : "Not set."} Direct add from the app: {s.calendar.api ? "on" : "off (needs GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY)"}.
          </Row>
          <Row ok={s.vault} label="Vault (VAULT_SOURCE=github, GH_VAULT_TOKEN)">Client roster, health pages and content-engine notes.</Row>
          <Row ok={s.roofCommand} label="Roof Command (ROOF_SUPABASE_URL, ROOF_SUPABASE_SERVICE_KEY)">Adds Roof Command roofers and plans to the client list. Read-only.</Row>
        </ul>
      </div>
      <h2 className="cc-h2">OS Supabase check</h2>
      <div className="cc-note">{probe}</div>
    </>
  );
}
