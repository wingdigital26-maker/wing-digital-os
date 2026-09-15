import GbpBoard from "./GbpBoard";

// /gbp: staff staging page for Google Business Profile post captions.
// Draft-and-stage only -- there is no accessible free GBP posting API for a
// small operator, so this page never posts anything and calls no external
// API. Thin server shell; all state lives in the client component, same
// pattern as /reviews.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "GBP posts",
  description: "Ready-to-paste Google Business Profile captions per client, staged for manual posting.",
};

export default function GbpPage() {
  return <GbpBoard />;
}
