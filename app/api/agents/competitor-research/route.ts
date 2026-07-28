import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { VAULT_PATH as VAULT } from "@/lib/vaultSource";

export const runtime = "nodejs";

const COMPETITORS_FILE = path.join(VAULT, "wiki", "concepts", "competitors.md");
const USAGE_FILE = path.join(process.cwd(), ".brave-usage.json");

const COST_PER_SEARCH = 0.005;   // $0.005 per Brave request
const MONTHLY_LIMIT = 4.50;      // hard stop at $4.50 — leaves $0.50 buffer below the $5 credit

function getUsage(): { month: string; spent: number; runs: number } {
  const thisMonth = new Date().toISOString().slice(0, 7); // "2026-06"
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"));
    if (raw.month !== thisMonth) return { month: thisMonth, spent: 0, runs: 0 };
    return raw;
  } catch {
    return { month: thisMonth, spent: 0, runs: 0 };
  }
}

function saveUsage(usage: { month: string; spent: number; runs: number }) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), "utf-8");
}

const SEARCH_QUERIES = [
  "DFW marketing automation agency home services 2024",
  "Dallas roofing contractor CRM automation agency",
  "GoHighLevel agency DFW Texas home services",
  "marketing agency missed call text back DFW",
  "home service marketing automation Dallas Fort Worth",
];

async function braveSearch(query: string): Promise<string[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&freshness=pw`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "X-Subscription-Token": key },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const results: string[] = [];
  for (const r of data.web?.results ?? []) {
    results.push(`${r.title} | ${r.url} | ${r.description ?? ""}`);
  }
  return results;
}

async function summarizeWithGroq(rawResults: string): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return rawResults;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: `You are a competitive intelligence analyst for Wing Digital, a DFW marketing automation agency at $1,000/month serving home service businesses (roofing, HVAC, plumbing, electrical, pool, landscaping). Solo operator, done-for-you model.

From the search results, extract and organize competitor intelligence. Output ONLY in this exact format — no intro text, no conclusion:

### [Competitor Name or Category]
- [specific finding about pricing, services, or positioning]
- [another finding]
- [another finding]

### [Next Competitor or Category]
- [finding]
- [finding]

Rules:
- Use real company names when found
- Include pricing if mentioned
- Note what services they emphasize
- Flag anything Wing Digital doesn't currently offer
- Group by competitor or by theme (e.g. "GoHighLevel Resellers", "Paid Ads Agencies", "General Marketing Agencies")
- If a category has no findings, skip it
- Max 8 sections, 4 bullets each
- No em dashes — use commas or periods`,
        },
        { role: "user", content: rawResults },
      ],
    }),
  });

  if (!res.ok) return rawResults;
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? rawResults;
}

export async function POST() {
  try {
    if (!process.env.BRAVE_SEARCH_API_KEY) {
      return NextResponse.json({ ok: false, error: "BRAVE_SEARCH_API_KEY is not set in .env.local — add it to enable live competitor research. Get a free key at brave.com/search/api" });
    }

    // Spend guard — never exceed monthly limit
    const usage = getUsage();
    const thisCost = SEARCH_QUERIES.length * COST_PER_SEARCH;
    if (usage.spent + thisCost > MONTHLY_LIMIT) {
      return NextResponse.json({
        ok: false,
        error: `Monthly Brave search budget reached ($${usage.spent.toFixed(2)} of $${MONTHLY_LIMIT} used this month). Resets on the 1st. Runs this month: ${usage.runs}.`,
      });
    }

    // Run all searches
    const allResults: string[] = [];
    for (const query of SEARCH_QUERIES) {
      const results = await braveSearch(query);
      if (results.length > 0) {
        allResults.push(`\n### Query: "${query}"`);
        allResults.push(...results);
      }
    }

    if (allResults.length === 0) {
      return NextResponse.json({ ok: false, error: "No search results returned. Check that BRAVE_SEARCH_API_KEY is valid." });
    }

    const rawText = allResults.join("\n");
    const summary = await summarizeWithGroq(rawText);

    const date = new Date().toISOString().slice(0, 10);
    const content = `# Competitor Intelligence

> Auto-updated every morning by Wing Digital OS.
> See [[agent-context]] for Wing Digital's positioning and pricing.
> See [[concepts/lessons-learned]] for what differentiates us technically.

---

## Last Updated: ${date}

${summary}

---

## How to Use This

- Use this to sharpen the sales pitch — what are competitors NOT offering?
- If a prospect mentions a competitor by name, search this file first
- Wing Digital differentiator: done-for-you setup, $1k/month, home service niche focus

---

*Generated by Wing Digital OS competitor research agent using Brave Search + Groq.*
`;

    fs.mkdirSync(path.dirname(COMPETITORS_FILE), { recursive: true });
    fs.writeFileSync(COMPETITORS_FILE, content, "utf-8");

    // Record spend
    usage.spent = Math.round((usage.spent + thisCost) * 1000) / 1000;
    usage.runs += 1;
    saveUsage(usage);

    return NextResponse.json({ ok: true, date, previewLength: summary.length, spent: usage.spent, runs: usage.runs, budget: MONTHLY_LIMIT });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message });
  }
}

// GET returns current file content + usage stats
export async function GET() {
  try {
    const usage = getUsage();
    const content = fs.existsSync(COMPETITORS_FILE)
      ? fs.readFileSync(COMPETITORS_FILE, "utf-8")
      : null;
    return NextResponse.json({
      ok: true,
      content,
      usage: { spent: usage.spent, runs: usage.runs, budget: MONTHLY_LIMIT, remaining: Math.max(0, MONTHLY_LIMIT - usage.spent) },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message });
  }
}
