// Display name + accent for each client on the add-a-customer page. Colours
// match the client's dashboard config (scripts/client_dashboard/clients/*.json)
// so the two links a client holds look like the same product. A slug not
// listed here falls back to public.clients.name and the house amber.
export type IntakeBrand = {
  name: string;
  initials: string;
  accentLight: string; // button + focus colour on the cream theme (white text on it)
  accentDark: string; // button + focus colour on the espresso theme (dark text on it)
};

const BRANDS: Record<string, IntakeBrand> = {
  "heros-junk": { name: "Hero's Junk Removal", initials: "HJ", accentLight: "#b22234", accentDark: "#e2586a" },
  "jackson-roofing": { name: "Jackson Roofing", initials: "JR", accentLight: "#06809f", accentDark: "#1bc0ff" },
  "renewal-health": { name: "Renewal Health", initials: "RH", accentLight: "#4f6d46", accentDark: "#a8c49e" },
};

const DEFAULT = { accentLight: "#a8650f", accentDark: "#e8a33d" };

function initialsOf(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]).join("") || "W").toUpperCase();
}

export function brandFor(slug: string, dbName: string | null): IntakeBrand {
  const known = BRANDS[slug];
  if (known) return known;
  const name = dbName || "Your business";
  return { name, initials: initialsOf(name), ...DEFAULT };
}
