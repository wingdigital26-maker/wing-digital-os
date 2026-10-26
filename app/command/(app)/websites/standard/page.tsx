import Link from "next/link";

// The website handoff standard. Drawn from the vault's house rules:
// wiki/concepts/website-hard-rules.md and website-and-app-standards.md.
// If those change, update this page to match.

const SECTIONS: { h: string; items: string[] }[] = [
  {
    h: "1. Tap to call everywhere",
    items: [
      "A real tel: link AND an sms: link visible above the fold on every page, every blog post included.",
      "A persistent call and text bar on phones.",
      "The contact form stays, and if it fails it shows the phone and text link instead.",
      "Never hide the header phone on mobile. Every Call button is a tel: link, not a button that opens a form.",
    ],
  },
  {
    h: "2. SEO basics",
    items: [
      "Every service gets its own real page with unique copy and service schema. No stubs, no homepage anchors.",
      "One H1 per page with the main keyword. Title under 60 characters, meta description under 155 with the keyword in it.",
      "LocalBusiness schema with the real name, address, phone and hours. FAQ blocks with FAQPage schema on home and about.",
      "A sitemap.xml with every page, robots.txt allowing it, and clean URLs.",
      "Internal links between related services and posts. No broken links (every link returns 200).",
    ],
  },
  {
    h: "3. Speed",
    items: [
      "Largest paint 2.5s or less, tap response 200ms or less, layout shift 0.1 or less, on a phone.",
      "Every image under 300KB, with width and height set. The hero image is never lazy loaded.",
      "Fonts self-hosted with font-display swap. Two font families at most.",
    ],
  },
  {
    h: "4. Look and use",
    items: [
      "Body text 16px or more, form inputs 16px or more (or iPhones zoom).",
      "Text contrast 4.5:1. Touch targets at least 44 by 44.",
      "Unique, real photos about the actual trade on every page. No photo repeats, no AI art, no illustrations.",
      "Limited motion, and prefers-reduced-motion respected.",
      "Never invent a price. Estimators give a plain-language scope and route to a person.",
    ],
  },
  {
    h: "5. Blog post standard",
    items: [
      "Every post shows its title on the card and the page, with the image as a cropped banner under it.",
      "The tap-to-call and text links appear on every post.",
      "Images are about the trade and the post's subject, never picked from an abstract heading.",
      "Keyword in the title, first paragraph and meta. Links to the related service page and the contact page.",
      "Client taboos are respected (for example: no gutter content for a roofer who does not do gutters, no insurance claims talk where banned).",
      "Written at a 5th to 7th grade level, no em dashes, no made-up facts or prices.",
    ],
  },
  {
    h: "6. Handback steps",
    items: [
      "Send the delivered link on the Websites board and mark the job Delivered.",
      "Run the site check: HTML clean, all links 200, accessibility (WCAG AA) on every page, images under 300KB.",
      "Jack reviews on a real phone: tap to call works, text works, the form sends.",
      "Hand over the source (repo or export) and every login created for the site.",
      "Jack moves it live, adds the Sentinel Config to the client's vault page so the daily check covers it, and marks Pansh paid.",
    ],
  },
];

export default function HandoffStandard() {
  return (
    <>
      <p><Link href="/command/websites">Websites</Link></p>
      <h1 className="cc-h1">Website handoff standard</h1>
      <p className="cc-lede">What every site Pansh builds must do before it goes to a client. From the vault&apos;s website rules (website-hard-rules and website-and-app-standards).</p>
      <div className="cc-grid two">
        {SECTIONS.map((s) => (
          <div key={s.h} className="cc-card">
            <h3>{s.h}</h3>
            <ul className="cc-list">{s.items.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        ))}
      </div>
    </>
  );
}
