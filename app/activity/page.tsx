import ActivityBoard from "./ActivityBoard";

// /activity — "Messaging Activity": one clear view of what email/text is going
// out, what is queued next (with word-for-word previews), and which lanes are
// live vs dead vs draft-only. Thin server shell; all fetch/state logic lives in
// the client component so the honest, non-optimistic empty states run in the
// browser. This surface sends nothing — it only reads the existing read-only
// endpoints (/api/messaging, /api/messages, /api/sms/health).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Messaging Activity",
  description: "What email and text is going out, what is queued, and which lanes are live.",
};

export default function ActivityPage() {
  return <ActivityBoard />;
}
