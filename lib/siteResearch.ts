// ───────────────────────────────────────────────────────────────────────────
// siteResearch: the OS reads a business's public website and writes down what
// it can actually see. No headless browser, no paid API, no scraping service,
// no model call. Regex and light parsing over the HTML of the homepage plus up
// to four more same-domain pages (contact / about / services / pricing / book).
//
// RULES
//   * NULL means unknown. A field the site never states stays null; the
//     summary says nothing about it.
//   * Every yes/no signal is a real observation of markup, not a guess.
//   * Hard limits: 8 s per page, 1.5 MB per page, 5 pages total.
// ───────────────────────────────────────────────────────────────────────────
import { normalizePhone } from "@/lib/phone";

export type Platform =
  | "wordpress" | "wix" | "squarespace" | "gohighlevel" | "duda"
  | "godaddy" | "webflow" | "shopify" | "unknown";

export type SiteSignals = {
  platform: Platform;
  has_contact_form: boolean;
  has_chat_widget: boolean;
  has_online_booking: boolean;
  has_ssl: boolean;
  mobile_viewport: boolean;
  title_length: number | null;
  meta_description_present: boolean;
  h1_count: number;
  pages_found: string[];
  load_ms: number | null;
};

export type SiteResearch = {
  website: string;          // final URL after redirects
  domain: string;
  name: string | null;
  phone: string | null;
  phones: string[];
  email: string | null;
  emails: string[];
  city: string | null;
  state: string | null;
  trade: string | null;
  services: string[];
  socials: Record<string, string>;
  signals: SiteSignals;
  summary: string;
};

const PAGE_TIMEOUT_MS = 8000;
const PAGE_CAP_BYTES = 1_500_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ── URL handling ───────────────────────────────────────────────────────────
export function normalizeUrl(input: string): URL | null {
  let s = (input || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || !u.hostname.includes(".")) return null;
  return u;
}

export function domainOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

// SSRF guard: no IP literals, no loopback/private/link-local names.
export function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\[?[0-9a-f:]+\]?$/i.test(h) && h.includes(":")) return false; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // any IPv4 literal
  if (/^\d+$/.test(h)) return false;
  return true;
}

// ── fetching ───────────────────────────────────────────────────────────────
type Page = { url: string; finalUrl: string; html: string; ms: number; status: number };

async function fetchPage(url: string): Promise<Page> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PAGE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
    });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (ct && !/html|xml|text\/plain/i.test(ct)) throw new Error(`Not an HTML page (${ct.split(";")[0]})`);
    // Read with a byte cap so a giant page cannot pin the function.
    const reader = r.body?.getReader();
    let html = "";
    if (reader) {
      const dec = new TextDecoder("utf-8", { fatal: false });
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        html += dec.decode(value, { stream: true });
        if (total >= PAGE_CAP_BYTES) { ctl.abort(); break; }
      }
    } else {
      html = (await r.text()).slice(0, PAGE_CAP_BYTES);
    }
    return { url, finalUrl: r.url || url, html, ms: Date.now() - started, status: r.status };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Timed out after ${PAGE_TIMEOUT_MS / 1000} s`);
    }
    // undici hides the real reason in `cause`; surface it in plain English.
    const code = (e as { cause?: { code?: string } })?.cause?.code;
    if (code === "ENOTFOUND") throw new Error("the domain does not resolve (no such site)");
    if (code === "ECONNREFUSED") throw new Error("the server refused the connection");
    if (code && /CERT|SSL|TLS/i.test(code)) throw new Error("the site's SSL certificate is broken");
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(t);
  }
}

// ── HTML helpers ───────────────────────────────────────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function textOnly(html: string): string {
  return stripTags(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
  );
}

function metaContent(html: string, attr: "property" | "name", key: string): string | null {
  const re = new RegExp(
    `<meta[^>]+${attr}=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  if (!m) return null;
  const c = m[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]).trim() || null : null;
}

type Link = { href: string; text: string };
function links(html: string): Link[] {
  const out: Link[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({ href: decodeEntities(m[1]).trim(), text: stripTags(m[2]).slice(0, 80) });
    if (out.length > 1500) break;
  }
  return out;
}

// ── extraction ─────────────────────────────────────────────────────────────
// Sites like to put the phone number in the title. A name is a name.
function cleanName(s: string): string {
  return s
    .replace(/\(?\+?1?[\s.-]?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "")
    .replace(/\s*[:|,–—-]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractName(html: string): string | null {
  const og = metaContent(html, "property", "og:site_name");
  if (og && og.length <= 80) return cleanName(og) || null;
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) {
    const full = stripTags(t[1]);
    const first = cleanName(full.split(/\s+[|–—-]\s+/)[0]);
    if (first && first.length <= 80 && !/^(home|welcome)$/i.test(first)) return first;
    if (full && full.length <= 80) return cleanName(full) || null;
  }
  const ld = html.match(/"name"\s*:\s*"([^"]{2,80})"/);
  if (ld) return cleanName(decodeEntities(ld[1])) || null;
  return null;
}

function extractPhones(pages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const n = normalizePhone(raw);
    if (!n.e164 || !n.e164.startsWith("+1") || n.e164.length !== 12) return;
    // Reject obviously fake / non-geographic patterns like 555 or all-same digits.
    const ten = n.e164.slice(2);
    if (/^(\d)\1{9}$/.test(ten) || ten.slice(3, 6) === "555") return;
    if (ten[0] === "0" || ten[0] === "1") return;
    if (!seen.has(n.e164)) { seen.add(n.e164); out.push(n.e164); }
  };
  for (const html of pages) {
    const tel = html.matchAll(/href=["']tel:([^"']+)["']/gi);
    for (const m of tel) push(decodeURIComponent(m[1]));
  }
  for (const html of pages) {
    const text = textOnly(html);
    const re = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) push(`${m[1]}${m[2]}${m[3]}`);
  }
  return out.slice(0, 5);
}

function extractEmails(pages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const imgLike = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i;
  const push = (raw: string) => {
    const e = decodeEntities(raw).trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return;
    if (imgLike.test(e) || /@(example|sentry|wixpress|schema)\./.test(e) || /^[a-f0-9]{16,}@/.test(e)) return;
    if (!seen.has(e)) { seen.add(e); out.push(e); }
  };
  for (const html of pages) {
    for (const m of html.matchAll(/href=["']mailto:([^"'?]+)/gi)) push(m[1]);
  }
  for (const html of pages) {
    for (const m of textOnly(html).matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) push(m[0]);
  }
  return out.slice(0, 5);
}

const STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

function extractCityState(pages: string[]): { city: string | null; state: string | null } {
  // schema.org first: it is the site saying it on purpose.
  for (const html of pages) {
    const loc = html.match(/"addressLocality"\s*:\s*"([^"]{2,40})"/);
    const reg = html.match(/"addressRegion"\s*:\s*"([^"]{2,20})"/);
    if (loc) {
      const st = reg ? reg[1].trim().toUpperCase() : null;
      return { city: decodeEntities(loc[1]).trim(), state: st && STATES.has(st) ? st : st ? stateAbbrev(st) : null };
    }
  }
  // Then a postal address in the text: "City, ST 75001".
  const counts = new Map<string, number>();
  for (const html of pages) {
    const text = textOnly(html);
    const re = /\b([A-Z][a-zA-Z.]+(?:\s[A-Z][a-zA-Z.]+){0,2}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!STATES.has(m[2])) continue;
      const key = `${m[1]}|${m[2]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) {
    const [city, state] = best[0].split("|");
    return { city, state };
  }
  return { city: null, state: null };
}

const STATE_NAMES: Record<string, string> = {
  texas: "TX", oklahoma: "OK", california: "CA", florida: "FL", arizona: "AZ", colorado: "CO",
  georgia: "GA", "new york": "NY", illinois: "IL", ohio: "OH", tennessee: "TN", "north carolina": "NC",
  louisiana: "LA", arkansas: "AR", "new mexico": "NM", missouri: "MO", kansas: "KS",
};
function stateAbbrev(s: string): string | null {
  return STATE_NAMES[s.trim().toLowerCase()] ?? null;
}

const GENERIC_NAV = new Set([
  "home", "about", "about us", "contact", "contact us", "blog", "news", "faq", "faqs", "gallery",
  "reviews", "testimonials", "careers", "login", "log in", "sign in", "privacy policy", "terms",
  "get a quote", "free quote", "free estimate", "request a quote", "learn more", "read more",
  "services", "our services", "menu", "search", "call now", "call us", "book now", "schedule",
  "financing", "portfolio", "locations", "service areas", "areas we serve", "resources", "shop", "cart",
]);

function cleanService(s: string): string | null {
  // "Furniture removal details" is the link caption, not the service.
  const t = s.replace(/\s+/g, " ").trim().replace(/[.:]+$/, "").replace(/\s+(details|info|page)$/i, "");
  if (t.length < 3 || t.length > 45) return null;
  if (GENERIC_NAV.has(t.toLowerCase())) return null;
  if (/^(see|how|why|what|we offer|explore|discover|more|all)\b|financing|maintenance plan|family plan|membership|coupon|special offer/i.test(t)) return null;
  // A sentence is not a service name.
  if (t.split(/\s+/).length > 5 || /\b(vs|it|you|your|we|our)\b|[,!?]/i.test(t)) return null;
  if (/^(company|team|overview|services?)$/i.test(t)) return null;
  if (/^\d|^(read|learn|click|view|see|get|call|our|the)\b/i.test(t) && !/\b(repair|install|removal|cleaning|service)/i.test(t)) return null;
  if (/[@|]|\$|http/.test(t)) return null;
  return t;
}

function extractServices(home: string, servicePages: string[], domain: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const c = cleanService(s);
    if (!c) return;
    // "Garage cleanout" and "Garage Cleanouts" are the same service.
    const k = c.toLowerCase().replace(/&/g, "and").replace(/s\b/g, "").replace(/[^a-z]/g, "");
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  // Nav links whose href mentions service, on the homepage.
  for (const l of links(home)) {
    const href = l.href.toLowerCase();
    if (!/service|repair|install|removal|cleaning|roof|plumb|hvac|paint|landscap|remodel|electric|pest|floor/.test(href)) continue;
    if (href.startsWith("http") && !href.includes(domain)) continue;
    if (/^(services|our services)$/i.test(l.text)) continue;
    add(l.text);
  }
  // Headings on any services page.
  for (const html of servicePages) {
    for (const m of html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)) add(stripTags(m[1]));
  }
  return out.slice(0, 15);
}

const SOCIAL_HOSTS: [string, RegExp][] = [
  ["facebook", /(?:^|\.)facebook\.com|(?:^|\.)fb\.com/i],
  ["instagram", /(?:^|\.)instagram\.com/i],
  ["linkedin", /(?:^|\.)linkedin\.com/i],
  ["tiktok", /(?:^|\.)tiktok\.com/i],
  ["youtube", /(?:^|\.)youtube\.com|(?:^|\.)youtu\.be/i],
  ["x", /(?:^|\.)twitter\.com|^x\.com$/i],
  ["google", /(?:^|\.)google\.com|(?:^|\.)g\.page|(?:^|\.)goo\.gl|(?:^|\.)maps\.app\.goo\.gl/i],
  ["yelp", /(?:^|\.)yelp\.com/i],
  ["nextdoor", /(?:^|\.)nextdoor\.com/i],
];

function extractSocials(pages: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const html of pages) {
    for (const l of links(html)) {
      let u: URL;
      try { u = new URL(l.href); } catch { continue; }
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      for (const [key, re] of SOCIAL_HOSTS) {
        if (out[key] || !re.test(u.hostname)) continue;
        const p = u.pathname.toLowerCase();
        // Skip share/intent/plugin links; keep only what looks like a profile.
        if (/sharer|share\.php|\/intent\/|plugins|\/embed|\/tr\b|dialog/.test(p + u.search)) continue;
        if (key === "google" && !/maps|\/business|g\.page|goo\.gl|search\?q=|\/local/.test(u.href.toLowerCase())) continue;
        if (key !== "google" && p.replace(/\/$/, "") === "") continue; // bare facebook.com
        out[key] = u.href;
      }
    }
  }
  return out;
}

function detectPlatform(html: string, headers?: Headers): Platform {
  const h = html.slice(0, 400_000).toLowerCase();
  if (/wp-content|wp-includes|wp-json/.test(h)) return "wordpress";
  if (/static\.wixstatic\.com|wix\.com|x-wix-|wixsite/.test(h)) return "wix";
  if (/squarespace\.com|static1\.squarespace|sqsp\.net/.test(h)) return "squarespace";
  if (/leadconnectorhq|msgsndr\.com|gohighlevel|highlevel/.test(h)) return "gohighlevel";
  if (/dudaone|duda\.co|cdn-cms\.f-static|dmws\.|d-cdn/.test(h)) return "duda";
  if (/godaddy|wsimg\.com|secureserver\.net/.test(h)) return "godaddy";
  if (/webflow\.com|assets-global\.website-files|website-files\.com|data-wf-/.test(h)) return "webflow";
  if (/cdn\.shopify\.com|shopify\.theme|myshopify/.test(h)) return "shopify";
  void headers;
  return "unknown";
}

function hasContactForm(pages: string[]): boolean {
  for (const html of pages) {
    for (const m of html.matchAll(/<form[\s\S]*?<\/form>/gi)) {
      const f = m[0].toLowerCase();
      if (/type=["']?(email|tel)|<textarea|name=["']?(email|phone|message)/.test(f)) return true;
    }
    // Embedded form iframes count too: the visitor sees a form.
    if (/<iframe[^>]+(forms?\.|leadconnectorhq\.com\/widget\/form|jotform|typeform|hsforms|cognitoforms)/i.test(html)) return true;
  }
  return false;
}

function hasChatWidget(pages: string[]): boolean {
  const re = /tawk\.to|intercom|drift\.com|driftt|tidio|podium\.com|podium\.co|leadconnectorhq\.com\/loader|chat-widget|chat_widget|livechat|zopim|zendesk.*chat|crisp\.chat|hubspot.*conversations|birdeye.*chat|smartsupp|olark|freshchat|gorgias/i;
  return pages.some((h) => re.test(h));
}

function hasOnlineBooking(pages: string[]): boolean {
  const re = /calendly\.com|acuityscheduling|housecallpro|housecall|getjobber\.com|clienthub\.app|servicetitan|schedulingengine|bookingkoala|setmore|squareup\.com\/appointments|vagaro|zenbooker|workiz|book-online|book online|schedule online|schedule-online|request appointment|leadconnectorhq\.com\/widget\/booking/i;
  return pages.some((h) => re.test(h));
}

// A rough trade guess from words the site itself uses, most frequent wins.
const TRADES: [string, RegExp][] = [
  ["roofing", /\broof(ing|er|ers|s)?\b/gi],
  ["junk removal", /\bjunk removal|hauling|haul away\b/gi],
  ["plumbing", /\bplumb(ing|er|ers)\b/gi],
  ["hvac", /\bhvac|air conditioning|heating (and|&) cooling|ac repair\b/gi],
  ["electrical", /\belectrician|electrical\b/gi],
  ["landscaping", /\blandscap(ing|e|er)|lawn care|lawn service\b/gi],
  ["painting", /\bpainting contractor|house paint|painters?\b/gi],
  ["pest control", /\bpest control|exterminat/gi],
  ["cleaning", /\bcleaning service|maid service|house cleaning|pressure washing|power washing\b/gi],
  ["remodeling", /\bremodel(ing|er)|renovation\b/gi],
  ["fencing", /\bfence|fencing\b/gi],
  ["pool service", /\bpool (service|cleaning|repair|builder)\b/gi],
  ["concrete", /\bconcrete|paving|asphalt\b/gi],
  ["tree service", /\btree (service|removal|trimming)|arborist\b/gi],
  ["garage doors", /\bgarage door\b/gi],
  ["dental", /\bdentist|dental\b/gi],
  ["law firm", /\battorney|law firm|lawyer\b/gi],
  ["real estate", /\breal estate|realtor\b/gi],
  ["auto repair", /\bauto repair|mechanic|collision\b/gi],
  ["restaurant", /\brestaurant|menu|catering\b/gi],
  ["salon", /\bsalon|barber|spa\b/gi],
  ["fitness", /\bgym|fitness|personal train/gi],
  ["medical", /\bclinic|chiropract|physical therapy|wellness\b/gi],
];

function guessTrade(pages: string[]): string | null {
  const text = pages.map(textOnly).join(" ").slice(0, 200_000);
  let best: { trade: string; n: number } | null = null;
  for (const [trade, re] of TRADES) {
    const n = (text.match(re) || []).length;
    if (n >= 3 && (!best || n > best.n)) best = { trade, n };
  }
  return best?.trade ?? null;
}

// ── summary (rules, no model) ──────────────────────────────────────────────
function buildSummary(r: Omit<SiteResearch, "summary">): string {
  const s = r.signals;
  const who = r.trade ? `${cap(r.trade)} company` : "Business";
  const where = r.city ? ` in ${r.city}${r.state ? `, ${r.state}` : ""}` : r.state ? ` in ${r.state}` : "";
  const on = s.platform !== "unknown" ? `, on ${platformLabel(s.platform)}` : "";
  const first = `${who}${where}${on}.`;

  const missing: string[] = [];
  if (!s.has_chat_widget) missing.push("no chat");
  if (!s.has_online_booking) missing.push("no online booking");
  if (!s.has_contact_form) missing.push("no contact form");
  const has: string[] = [];
  if (s.has_chat_widget) has.push("chat");
  if (s.has_online_booking) has.push("online booking");
  if (s.has_contact_form) has.push("a contact form");

  let second: string;
  if (missing.length === 3) {
    second = "No chat, no online booking, and no contact form, so a visitor who wants to reach them has to pick up the phone.";
  } else if (missing.length === 0) {
    second = "The site already has chat, online booking, and a contact form; the opening is elsewhere, likely search visibility or content.";
  } else {
    const hasTxt = joinList(has);
    const missTxt = joinList(missing);
    second = `Has ${hasTxt} but ${missTxt}${!r.phone ? ", and no phone number is shown on the site" : ""}.`;
  }
  const extras: string[] = [];
  if (!s.mobile_viewport) extras.push("The pages are not set up for phones.");
  if (!s.meta_description_present) extras.push("The homepage has no meta description, which hurts how it shows in search.");
  if (s.h1_count === 0) extras.push("The homepage has no main heading.");
  return [first, second, ...extras.slice(0, 1)].join(" ");
}

function joinList(xs: string[]): string {
  if (xs.length <= 1) return xs[0] || "";
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;
}
function cap(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bHvac\b/, "HVAC");
}
export function platformLabel(p: Platform): string {
  return ({
    wordpress: "WordPress", wix: "Wix", squarespace: "Squarespace", gohighlevel: "GoHighLevel",
    duda: "Duda", godaddy: "GoDaddy", webflow: "Webflow", shopify: "Shopify", unknown: "an unknown platform",
  } as Record<Platform, string>)[p];
}

// ── main ───────────────────────────────────────────────────────────────────
const SUBPAGE_RE = /contact|about|service|pricing|price|book|schedule/i;

function isServicesIndex(path: string): boolean {
  return /^\/(our-|all-)?services?(\.html|\/index\.html|\/)?$/i.test(path.replace(/\/+$/, "") || "/");
}

export async function researchSite(input: string): Promise<SiteResearch> {
  const start = normalizeUrl(input);
  if (!start) throw new Error("That is not a web address we can open.");
  if (!isPublicHost(start.hostname)) throw new Error("That address points at a private or internal host.");

  const domain = domainOf(start);
  let home: Page;
  try {
    home = await fetchPage(start.href);
  } catch (e) {
    // Try the other scheme once: some small sites only answer on http.
    if (start.protocol === "https:") {
      const alt = new URL(start.href);
      alt.protocol = "http:";
      try {
        home = await fetchPage(alt.href);
      } catch {
        throw new Error(`Could not open ${domain}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      throw new Error(`Could not open ${domain}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const finalUrl = new URL(home.finalUrl);
  if (!isPublicHost(finalUrl.hostname)) throw new Error("The site redirected to a private host.");
  const finalDomain = domainOf(finalUrl);

  // Pick up to 4 same-domain subpages from the homepage's links.
  const candidates = new Map<string, string>(); // path -> absolute
  for (const l of links(home.html)) {
    let u: URL;
    try { u = new URL(l.href, finalUrl); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (domainOf(u) !== finalDomain) continue;
    const path = u.pathname.replace(/\/+$/, "");
    if (!path || path === "/") continue;
    if (!SUBPAGE_RE.test(path)) continue;
    if (/\.(pdf|jpg|png|zip|xml)$/i.test(path)) continue;
    u.hash = "";
    u.search = "";
    if (!candidates.has(path)) candidates.set(path, u.href);
    if (candidates.size >= 24) break;
  }
  // A services page and a contact page carry the most facts; take those
  // before a reviews or about page fills the four slots.
  const rank = (p: string) =>
    /contact/i.test(p) ? 0
    : isServicesIndex(p) ? 1
    : /pricing|price/i.test(p) ? 2
    : /book|schedule/i.test(p) ? 3
    : /about/i.test(p) ? 4
    : /service-area|areas/i.test(p) ? 6
    : 5;
  const picked = [...candidates.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].length - b[0].length)
    .slice(0, 4);

  const subs = await Promise.allSettled(picked.map(([, href]) => fetchPage(href)));
  const pages: Page[] = [home];
  const pagesFound = ["/"];
  subs.forEach((s, i) => {
    if (s.status === "fulfilled") {
      pages.push(s.value);
      pagesFound.push(picked[i][0]);
    }
  });
  const htmls = pages.map((p) => p.html);
  // Only the services INDEX page feeds the services list. Headings on a deep
  // "garage cleanouts" page are section titles, not services.
  const servicePages = pages
    .filter((p) => isServicesIndex(new URL(p.url).pathname) || /pricing|price/i.test(p.url))
    .map((p) => p.html);

  const name = extractName(home.html);
  const phones = extractPhones(htmls);
  const emails = extractEmails(htmls);
  const { city, state } = extractCityState(htmls);
  const services = extractServices(home.html, servicePages, finalDomain);
  const socials = extractSocials(htmls);
  const trade = guessTrade(htmls);

  const titleM = home.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? stripTags(titleM[1]) : null;
  const signals: SiteSignals = {
    platform: detectPlatform(home.html),
    has_contact_form: hasContactForm(htmls),
    has_chat_widget: hasChatWidget(htmls),
    has_online_booking: hasOnlineBooking(htmls),
    has_ssl: finalUrl.protocol === "https:",
    mobile_viewport: /<meta[^>]+name=["']viewport["']/i.test(home.html),
    title_length: title ? title.length : null,
    meta_description_present: !!metaContent(home.html, "name", "description"),
    h1_count: (home.html.match(/<h1\b/gi) || []).length,
    pages_found: pagesFound,
    load_ms: home.ms,
  };

  const base: Omit<SiteResearch, "summary"> = {
    website: finalUrl.href,
    domain: finalDomain,
    name,
    phone: phones[0] ?? null,
    phones,
    email: emails[0] ?? null,
    emails,
    city,
    state,
    trade,
    services,
    socials,
    signals,
  };
  return { ...base, summary: buildSummary(base) };
}
