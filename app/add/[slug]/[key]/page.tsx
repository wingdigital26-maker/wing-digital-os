import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import { checkClientKey, clientName } from "@/lib/clientIntake";
import { brandFor } from "../../brands";
import AddCustomerForm from "./AddCustomerForm";
import "../../add.css";

// ───────────────────────────────────────────────────────────────────────────
// /add/<client-slug>/<key>: the page a client opens on their phone after a job
// to add the customer they just served. Same path-style link as the
// /d/<slug>/<key> dashboard (chat and SMS apps keep the path, not the query).
//
// The key is checked HERE, server side, before the form is shown, and again by
// /api/intake/<slug> on every save. Fails closed: a wrong key shows a plain
// "this link isn't valid" card, and a database that can't answer shows "try
// again", never a form that would pretend to save.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const display = Fraunces({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-display" });
const body = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Add a customer",
  robots: { index: false, follow: false },
};

const SLUG_RE = /^[a-z0-9-]{2,60}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <main className="ac-wrap">
      <section className="ac-card ac-notice">
        <h1 className="ac-h1">{title}</h1>
        <p className="ac-sub">{text}</p>
      </section>
    </main>
  );
}

export default async function AddCustomerPage({
  params,
}: {
  params: Promise<{ slug: string; key: string }>;
}) {
  const { slug, key } = await params;

  let state: "ok" | "denied" | "down" = "denied";
  if (SLUG_RE.test(slug) && KEY_RE.test(key)) {
    try {
      state = await checkClientKey(slug, key);
    } catch (e) {
      console.error("[add] key check failed:", e instanceof Error ? e.message : e);
      state = "down";
    }
  }

  const brand = brandFor(slug, state === "ok" ? await clientName(slug) : null);
  const style = {
    "--ac-accent-l": brand.accentLight,
    "--ac-accent-d": brand.accentDark,
  } as React.CSSProperties;

  return (
    <div className={`ac-root ${display.variable} ${body.variable}`} style={style}>
      {state === "denied" && (
        <Notice
          title="This link isn't valid"
          text="It may have been typed wrong or replaced with a new one. Ask Wing Digital to send you your link again."
        />
      )}
      {state === "down" && (
        <Notice
          title="We can't open your customer list right now"
          text="Nothing is wrong with your link. Please try again in a minute or two."
        />
      )}
      {state === "ok" && (
        <main className="ac-wrap">
          <div className="ac-head">
            <span className="ac-mark" aria-hidden="true">{brand.initials}</span>
            <div>
              <div className="ac-brand">{brand.name}</div>
              <div className="ac-by">Customer list, kept by Wing Digital</div>
            </div>
          </div>
          <AddCustomerForm slug={slug} accessKey={key} />
        </main>
      )}
    </div>
  );
}
