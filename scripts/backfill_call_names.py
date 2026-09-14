#!/usr/bin/env python3
"""
Backfill missing contact names on the OS call sheet.

Of the rows in Supabase public.call_leads, a large share carry no
contact_name -- the caller sees "No named contact" and has to ask for whoever
handles marketing. Some of those rows CAN be named: the local prospects.db has
picked up an owner/contact name for the same company since the row was first
synced. This script finds those and patches ONLY the name.

It joins on the company (call_leads.company_key -- the stored normalized,
lowercased company name -- against a normalized prospects.name), and it will
only ever write a name that looks like a REAL person's name. The B2B scrape
batches store junk in the name columns (an email local-part like "Insidesales"
or "Nortexfan"); writing those to the call sheet would be fabricating a
contact, which is worse than an honest blank. The validator below rejects them.

A lead with no genuine name on file stays "No named contact". That is correct.

Only contact_name is touched. Status, claims, call counts and every other
working-state column are never in the payload, so a run cannot disturb the room.

Usage:
    python scripts/backfill_call_names.py            # dry run (default)
    python scripts/backfill_call_names.py --commit   # actually patch names
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request

PROSPECTS_DB = r"C:\Users\wjack\ghl-cli\prospects.db"
# Supabase creds live in the OS app env, not the pipeline .env.
ENV_FILES = [
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env.local"),
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"),
    r"C:\Users\wjack\ghl-cli\.env",
]

_SUFFIXES = {"inc", "llc", "ltd", "co", "company", "corp", "corporation", "the", "and"}

# Words that make a capitalized two-token string a place or trade, not a person.
# Any name containing one of these is rejected by is_real_name.
_NON_NAME_WORDS = {
    "north", "south", "east", "west", "northern", "southern", "eastern", "western",
    "fort", "lake", "metro", "greater", "central", "texas", "tx", "dallas", "worth",
    "plano", "frisco", "mckinney", "allen", "denton", "collin", "county", "city",
    "roofing", "construction", "exteriors", "restoration", "contractors", "services",
    "solutions", "systems", "group", "enterprises", "industries", "supply",
    "heating", "cooling", "plumbing", "electric", "electrical", "hvac", "pools",
    "landscaping", "remodeling", "builders", "homes", "properties", "realty",
}


def load_env() -> dict:
    out = {}
    for path in ENV_FILES:
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    for k in ("OS_SUPABASE_URL", "OS_SUPABASE_SERVICE_KEY"):
        if os.environ.get(k):
            out[k] = os.environ[k]
    return out


def is_real_name(nm: str | None) -> bool:
    """True only for something that reads like a person's name.

    Two or more tokens, each alphabetic (allowing . - ' inside), each starting
    with a capital. This deliberately rejects the email-local-part strings the
    B2B scraper leaves in owner_name/contact_name ("Insidesales", "Nortexfan",
    "Dcscgv") -- one lowercase blob is not a name and must never reach a caller.
    """
    nm = (nm or "").strip()
    if not nm:
        return False
    toks = nm.split()
    if len(toks) < 2:
        return False
    for t in toks:
        core = t.strip(".").replace("-", "").replace("'", "")
        if not core.isalpha():
            return False
        if not t[0].isupper():
            return False
    # Belt-and-suspenders: a capitalized two-token string can still be a place
    # or trade name ("North Texas", "Fort Worth", "Metro Roofing") that would
    # read as a person to a caller. If ANY token is a known place/trade word,
    # it is not a person's name. 2026-09-13.
    if any(t.lower().strip(".-'") in _NON_NAME_WORDS for t in toks):
        return False
    return True


def norm_company(s: str | None) -> str:
    """Normalize a company name for fuzzy matching: lowercase, drop punctuation
    and the common legal suffixes so "Superior One Roofing & Construction, Inc"
    matches "Superior One Roofing & Construction"."""
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = " ".join(t for t in s.split() if t not in _SUFFIXES)
    return re.sub(r"\s+", " ", s).strip()


def build_name_map() -> tuple[dict, dict]:
    """Return (exact_key -> name, normalized_key -> name) from prospects.db,
    keeping only genuine person names. contact_name wins over owner_name."""
    db = sqlite3.connect(PROSPECTS_DB)
    db.row_factory = sqlite3.Row
    exact: dict[str, str] = {}
    fuzzy: dict[str, str] = {}
    for p in db.execute("SELECT name, owner_name, contact_name FROM prospects"):
        name = None
        for cand in ((p["contact_name"] or "").strip(), (p["owner_name"] or "").strip()):
            if is_real_name(cand):
                name = cand
                break
        if not name:
            continue
        k = (p["name"] or "").strip().lower()
        nk = norm_company(p["name"])
        if k:
            exact.setdefault(k, name)
        if nk:
            fuzzy.setdefault(nk, name)
    db.close()
    return exact, fuzzy


def fetch_null_name_leads(url: str, key: str) -> list[dict]:
    rows: list[dict] = []
    off = 0
    while True:
        req = urllib.request.Request(
            f"{url}/rest/v1/call_leads?select=id,company,company_key"
            f"&contact_name=is.null&limit=1000&offset={off}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            batch = json.load(resp)
        rows.extend(batch)
        if len(batch) < 1000:
            break
        off += 1000
    return rows


def patch_name(url: str, key: str, lead_id: str, name: str) -> tuple[int, str]:
    req = urllib.request.Request(
        f"{url}/rest/v1/call_leads?id=eq.{urllib.request.quote(lead_id)}",
        data=json.dumps({"contact_name": name}).encode(),
        method="PATCH",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, ""
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="ignore")[:300]
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def plan_backfill(url: str, key: str) -> list[tuple[str, str, str]]:
    """Return [(lead_id, company, name)] for every NULL-name lead we can fill."""
    exact, fuzzy = build_name_map()
    leads = fetch_null_name_leads(url, key)
    print(f"{len(leads)} call_leads have no contact_name")
    plan: list[tuple[str, str, str]] = []
    for row in leads:
        ck = (row.get("company_key") or "").strip()
        name = exact.get(ck) or fuzzy.get(norm_company(ck))
        if name:
            plan.append((row["id"], row.get("company") or ck, name))
    return plan


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="actually patch names in Supabase")
    args = ap.parse_args()

    env = load_env()
    url = env.get("OS_SUPABASE_URL")
    key = env.get("OS_SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("ERROR: OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY not found.", file=sys.stderr)
        return 1

    plan = plan_backfill(url, key)
    print(f"  {len(plan)} of them can be filled with a REAL name from prospects.db")
    for _id, company, name in plan[:20]:
        print(f"    {company[:44]:44s} -> {name}")
    if len(plan) > 20:
        print(f"    ... and {len(plan) - 20} more")

    if not plan:
        print("\nNothing to fill. The remaining blanks have no genuine name on file "
              "(a blank is honest -- we never invent a contact).")
        return 0

    if not args.commit:
        print("\nDRY RUN. Nothing was written. Re-run with --commit to patch.")
        return 0

    filled = 0
    for lead_id, company, name in plan:
        status, err = patch_name(url, key, lead_id, name)
        if status not in (200, 204):
            print(f"  FAILED {company}: HTTP {status} {err}", file=sys.stderr)
            continue
        filled += 1
    print(f"\nBackfilled {filled} contact names into the call room.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
