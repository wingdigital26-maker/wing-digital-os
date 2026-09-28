import OutreachBoard from "./OutreachBoard";
import BackToOs from "../components/BackToOs";
import "../activity/activity.css";
import "./outreach.css";

// /outreach: the review queue for the custom cold-email engine (ghl-cli).
// Today's drafted sequences as cards (company, contact, the research facts
// each email stands on, every step, the QA result) with edit / approve /
// reject; what Instantly did with them; who is due a re-touch round; who is
// suppressed and why. Approving only records the decision. Nothing on this
// page sends an email, and pushing to Instantly is a separate step that is
// switched off unless OUTREACH_PUSH_ENABLED=1.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Outreach",
  description: "Review, approve and track the custom cold-email sequences.",
};

export default function OutreachPage() {
  return (
    <>
      <div style={{ padding: "16px 22px 0" }}>
        <BackToOs />
      </div>
      <OutreachBoard />
    </>
  );
}
