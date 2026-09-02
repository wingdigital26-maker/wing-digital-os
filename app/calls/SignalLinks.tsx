"use client";

// Every audit signal on a lead card is a CLAIM about something on the
// internet ("no website", "reviews gone stale"). Jack's rule: every flagged
// problem carries a one-click link to the thing itself, so a caller can see
// the evidence mid-call instead of taking our word for it.
//
// Signals are free text separated by commas, so linking is keyword-mapped:
//   website / chat / booking  -> their website (or a Google search when none)
//   reviews / rating / GBP    -> their Google Maps listing (search by name)
//   BBB                       -> BBB search for the company
//   anything else             -> Google search for the company
export default function SignalLinks({
  signals,
  company,
  city,
  website,
}: {
  signals: string;
  company: string;
  city: string | null;
  website: string | null;
}) {
  const q = encodeURIComponent(`${company} ${city ?? ""}`.trim());
  const parts = signals.split(",").map(s => s.trim()).filter(Boolean);

  function hrefFor(sig: string): string {
    const s = sig.toLowerCase();
    if (s.includes("bbb")) return `https://www.bbb.org/search?find_text=${encodeURIComponent(company)}&find_loc=${encodeURIComponent(city ?? "TX")}`;
    if (s.includes("review") || s.includes("rating") || s.includes("gbp") || s.includes("photo"))
      return `https://www.google.com/maps/search/?api=1&query=${q}`;
    if (s.includes("website") || s.includes("site") || s.includes("chat") || s.includes("booking"))
      return website ? (website.startsWith("http") ? website : `https://${website}`) : `https://www.google.com/search?q=${q}`;
    return `https://www.google.com/search?q=${q}`;
  }

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "2px 10px" }}>
      {parts.map((sig, i) => (
        <a
          key={i}
          href={hrefFor(sig)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          style={{ color: "#7dd3fc", textDecoration: "underline", textUnderlineOffset: 2 }}
        >
          {sig}
        </a>
      ))}
    </span>
  );
}
