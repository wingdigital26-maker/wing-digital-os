import EmailComposer from "./EmailComposer";

// /email — the staff email surface. Two clearly separated jobs:
//  * Send now (1:1): an instant SMTP send through /api/email/send.
//  * Add to cold campaign: enqueue a prospect into the Instantly cold
//    campaign through /api/email/campaign (Instantly sends on its own
//    schedule, NOT immediately).
// The page is a thin server shell; all the form and fetch logic lives in the
// client component so the honest, non-optimistic states run in the browser.
export const metadata = {
  title: "Email",
  description: "Send a 1:1 email or add a prospect to the cold campaign.",
};

export default function EmailPage() {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 20px 60px" }}>
      <EmailComposer />
    </div>
  );
}
