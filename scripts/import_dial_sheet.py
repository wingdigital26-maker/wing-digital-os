#!/usr/bin/env python3
"""
Import Maddox's cold-call dial sheets (github.com/wingdigital26-maker/wing-dial-sheet)
into the OS call room (Supabase public.call_leads), assigned to Maddox.

Two sheets, both self-contained HTML with the lead data in the markup:
  index.html          -> source "wing-dial-sheet"           (mid-tier list)
  verified/index.html -> source "wing-dial-sheet-verified"  (Maps-verified roofers)

Outcome marks (booked / no answer / etc.) on the sheet live ONLY in the
caller's browser localStorage -- the page says so itself ("no server to post
to"). Nothing here fabricates outcomes: every lead imports as-is with no
status field in the payload, so existing work in the room is never touched.

Idempotent: upserts on company_key (lower(btrim(company))). Working state
(status, claims, call counts) is never in the payload, so it cannot be wiped.

Usage:
    python scripts/import_dial_sheet.py            # dry run
    python scripts/import_dial_sheet.py --commit   # actually push
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from html import unescape
from html.parser import HTMLParser

ENV = r"C:\Users\wjack\ghl-cli\.env"
RAW = "https://raw.githubusercontent.com/wingdigital26-maker/wing-dial-sheet/master/"
SHEETS = [
    ("index.html", "wing-dial-sheet"),
    ("verified/index.html", "wing-dial-sheet-verified"),
]
MADDOX_ID = "b31af255-1720-4b7d-a126-1e6e23ba8791"
MADDOX_EMAIL = "maddox@wingdigital.co"


def load_env() -> dict:
    out = {}
    if os.path.exists(ENV):
        with open(ENV, encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("OS_SUPABASE_URL", "OS_SUPABASE_SERVICE_KEY"):
        if os.environ.get(k):
            out[k] = os.environ[k]
    return out


def fetch(path: str) -> str:
    req = urllib.request.Request(RAW + path, headers={"User-Agent": "wing-import/1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", errors="replace")


class SheetParser(HTMLParser):
    """Pulls per-lead fields out of <article class="lead"> blocks.

    Works for both sheet layouts: company is the first h2/h3 in the article,
    phone is the a.tel, website the first http link that is not a 'check it'
    citation, city the text before the first separator in .where/.loc,
    contact the <b> inside .who ('ask for NAME'), email any <code>/.mail
    containing an @, chips become signals.
    """

    def __init__(self):
        super().__init__()
        self.leads: list[dict] = []
        self.cur: dict | None = None
        self.stack: list[str] = []  # css-ish context
        self.buf: str | None = None
        self.capture: str | None = None
        self.flag_depth = 0  # >0 while inside a .flag warning block

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = (a.get("class") or "").split()
        if tag == "article" and "lead" in cls:
            self.cur = {"company": None, "phone": None, "website": None,
                        "city": None, "vertical": None, "contact": None,
                        "email": None, "chips": []}
            return
        if self.cur is None:
            return
        if tag == "div":
            if self.flag_depth or "flag" in cls:
                self.flag_depth += 1
            return
        if self.flag_depth:
            return  # data inside a "check before you dial" warning is not lead facts
        if tag in ("h2", "h3") and not self.cur["company"]:
            self.capture, self.buf = "company", ""
        elif tag == "a" and "tel" in cls:
            self.capture, self.buf = "phone", ""
        elif tag == "a" and (a.get("href") or "").startswith("http"):
            if "src" not in cls and not self.cur["website"]:
                self.cur["website"] = a["href"]
        elif tag == "p" and ("where" in cls or "loc" in cls):
            self.capture, self.buf = "loc", ""
        elif tag == "span" and "who" in cls:
            self.capture, self.buf = "who", ""
        elif tag == "span" and "mail" in cls:
            self.capture, self.buf = "email", ""
        elif tag == "code":
            self.capture, self.buf = "code", ""
        elif tag == "li":
            self.capture, self.buf = "chip", ""

    def handle_endtag(self, tag):
        if self.cur is None:
            return
        if tag == "div" and self.flag_depth:
            self.flag_depth -= 1
            return
        if tag == "article":
            if self.cur["company"]:
                self.leads.append(self.cur)
            self.cur = None
            self.capture = None
            return
        if self.capture and tag in ("h2", "h3", "a", "p", "span", "code", "li"):
            text = unescape(re.sub(r"\s+", " ", self.buf or "")).strip()
            c = self.cur
            if self.capture == "company":
                c["company"] = text
            elif self.capture == "phone":
                c["phone"] = text
            elif self.capture == "loc":
                # "Cleburne · roofing · huntroofing.net" / "Plano · their site"
                parts = [p.strip() for p in re.split(r"[·\u00b7]", text) if p.strip()]
                if parts:
                    c["city"] = parts[0]
                if len(parts) >= 3:
                    c["vertical"] = parts[1]
            elif self.capture == "who":
                m = re.search(r"ask for\s+(.+)", text, re.I)
                if m:
                    c["contact"] = m.group(1).strip() or None
            elif self.capture in ("email", "code"):
                if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", text) and not c["email"]:
                    c["email"] = text
            elif self.capture == "chip":
                if text:
                    c["chips"].append(text)
            self.capture, self.buf = None, None

    def handle_data(self, data):
        if self.capture is not None:
            self.buf = (self.buf or "") + data


def parse_sheet(html_text: str, source: str, default_vertical: str) -> list[dict]:
    p = SheetParser()
    p.feed(html_text)
    out = []
    for i, l in enumerate(p.leads, 1):
        out.append({
            "company": l["company"],
            "contact_name": l["contact"],
            "title": None,
            "phone": l["phone"],
            "email": l["email"],
            "website": l["website"],
            "city": l["city"],
            "state": "TX",
            "vertical": l["vertical"] or default_vertical,
            "score": 0,
            "signals": "; ".join(l["chips"]) or None,
            "source": source,
            "external_id": f"{source}:{i}",
            "excluded": False,
            "excluded_reason": None,
            "assigned_to": MADDOX_ID,
            "assigned_to_email": MADDOX_EMAIL,
        })
    return out


def push(url: str, key: str, path: str, rows: list[dict], prefer: str) -> tuple[int, str]:
    req = urllib.request.Request(
        f"{url}/rest/v1/{path}",
        data=json.dumps(rows if isinstance(rows, list) else rows).encode(),
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": prefer,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, ""
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="ignore")[:500]
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="actually write to Supabase")
    args = ap.parse_args()

    per_source: dict[str, list[dict]] = {}
    for path, source in SHEETS:
        html_text = fetch(path)
        default_vertical = "roofing" if "verified" in source else None
        leads = parse_sheet(html_text, source, default_vertical)
        per_source[source] = leads
        print(f"{source}: parsed {len(leads)} leads from {path}")

    # Collapse duplicate company keys before sending (Postgres rejects a batch
    # hitting the same conflict key twice). Verified sheet wins on overlap.
    deduped: dict[str, dict] = {}
    for source in ("wing-dial-sheet-verified", "wing-dial-sheet"):
        for l in per_source[source]:
            k = (l["company"] or "").strip().lower()
            if k and k not in deduped:
                deduped[k] = l
    all_leads = list(deduped.values())
    dropped = sum(len(v) for v in per_source.values()) - len(all_leads)
    if dropped:
        print(f"  collapsed {dropped} duplicate company rows across the two sheets")

    no_phone = [l for l in all_leads if not l["phone"]]
    print(f"{len(all_leads)} unique leads ready, all assigned to {MADDOX_EMAIL}")
    if no_phone:
        print(f"  note: {len(no_phone)} have no phone")
    for l in all_leads[:8]:
        print(f"  {l['source'][-8:]:>9s}  {(l['company'] or '')[:38]:38s} "
              f"{l['phone'] or '(no phone)':16s} {l['city'] or ''}")
    print(f"  ... and {max(0, len(all_leads) - 8)} more")

    if not args.commit:
        print("\nDRY RUN. Nothing was written. Re-run with --commit to push.")
        return 0

    env = load_env()
    url, key = env.get("OS_SUPABASE_URL"), env.get("OS_SUPABASE_SERVICE_KEY")
    if not url or not key:
        print(f"\nERROR: OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY not found in {ENV}.",
              file=sys.stderr)
        return 1

    sent = 0
    for i in range(0, len(all_leads), 100):
        chunk = all_leads[i:i + 100]
        status, err = push(url, key, "call_leads?on_conflict=company_key", chunk,
                           "resolution=merge-duplicates,return=minimal")
        if status not in (200, 201, 204):
            print(f"\nFAILED on rows {i}-{i + len(chunk)}: HTTP {status} {err}",
                  file=sys.stderr)
            print(f"{sent} leads were pushed before the failure.", file=sys.stderr)
            return 1
        sent += len(chunk)

    for source, leads in per_source.items():
        n = sum(1 for l in all_leads if l["source"] == source)
        batch = {"source": source, "total": n, "serviceable": n, "excluded": 0}
        status, err = push(url, key, "call_lead_batches", batch, "return=minimal")
        if status not in (200, 201, 204):
            print(f"  (leads synced, but batch record for {source} failed: "
                  f"HTTP {status} {err})", file=sys.stderr)

    print(f"\nPushed {sent} leads into the call room, assigned to {MADDOX_EMAIL}.")
    print("Reminder: outcome marks on the sheet live only in Maddox's browser "
          "localStorage; they were NOT imported.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
