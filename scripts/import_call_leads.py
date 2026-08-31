#!/usr/bin/env python3
"""
Push cold-call-ready leads from the local prospects.db into the OS call room
(Supabase public.call_leads), so callers signing in from anywhere can work them.

Only SERVICEABLE leads go up. A row with an excluded_reason stays local -- the
whole point of the quality pass was to keep unsellable businesses off the dial
list, and syncing them anyway would quietly undo that.

Idempotent: upserts on lower(company), so re-running updates existing rows
instead of creating duplicates for someone to waste a dial on. Working state
(status, claims, call counts) is NEVER overwritten -- that belongs to the room.

Usage:
    python scripts/import_call_leads.py            # dry run, shows what would go
    python scripts/import_call_leads.py --commit   # actually push
    python scripts/import_call_leads.py --commit --source apollo-2026-08-29
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

DB = r"C:\Users\wjack\ghl-cli\prospects.db"
ENV = r"C:\Users\wjack\ghl-cli\.env"


def load_env() -> dict:
    """Read the local .env. Secrets live here and never in the vault."""
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


def fetch_leads(source: str | None) -> list[dict]:
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    # Rejected leads come up TOO, flagged, with the reason attached. Syncing
    # only the survivors made the quality pass invisible -- you could not tell
    # "we found 65 leads" from "we found 100 and rejected 35" -- and it meant
    # the same dead company got re-imported on every future scrape. The dial
    # list filters excluded rows out; the Sources screen shows them.
    #
    # The trade tag is NOT used as a gate when --source is given: a source tag
    # already names an audited batch exactly, and some of those rows carry an
    # older trade label from a previous scrape (e.g. 'commercial-plumbing').
    # Gating on trade as well silently dropped three perfectly good leads.
    q = """
        SELECT name, owner_name, email, phone, website, linkedin, city, state,
               vertical, intent_score, signals, source, audit_notes, excluded_reason
          FROM prospects
         -- A lead needs a way to be REACHED, not specifically an email. This is
         -- a call room: a business with a phone and no email is perfectly
         -- dialable, and requiring an email silently hid six audited leads.
         --
         -- The outer parens are load-bearing. Without them the trailing
         -- "AND source = ?" binds to the phone branch only (AND > OR), so the
         -- email branch loses its source filter and the query returns the whole
         -- prospects table -- 1,757 rows instead of 100.
         WHERE ((email IS NOT NULL AND email <> '')
             OR (phone IS NOT NULL AND phone <> ''))
    """
    args: list = []
    if source:
        q += " AND source = ?"
        args.append(source)
    else:
        q += " AND trade = 'b2b'"
    rows = [dict(r) for r in db.execute(q, args)]
    db.close()
    return rows


def to_call_lead(r: dict) -> dict:
    # audit_notes format from the scorer: "Name | Title | N emp | signals"
    title = None
    employees = None
    parts = [p.strip() for p in (r.get("audit_notes") or "").split("|")]
    if len(parts) >= 2:
        title = parts[1] or None
    for p in parts:
        if p.endswith("emp"):
            try:
                employees = int(p.replace("emp", "").strip())
            except ValueError:
                pass
    return {
        "company": r["name"],
        "contact_name": r.get("owner_name"),
        "title": title,
        "phone": r.get("phone"),
        "email": r.get("email"),
        "website": r.get("website"),
        "linkedin": r.get("linkedin"),
        "city": r.get("city"),
        "state": r.get("state") or "TX",
        "vertical": r.get("vertical"),
        "employees": employees,
        "score": int(r.get("intent_score") or 0),
        "signals": r.get("signals"),
        "source": r.get("source"),
        "excluded": bool((r.get("excluded_reason") or "").strip()),
        "excluded_reason": (r.get("excluded_reason") or "").strip() or None,
    }


def push(url: str, key: str, rows: list[dict]) -> tuple[int, str]:
    """Upsert on company_key (a stored generated column holding the normalized
    company name). merge-duplicates updates the lead facts; it deliberately
    never touches status/claim/call_count because those columns are simply not
    in the payload, so a re-sync cannot wipe out a caller's work."""
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{url}/rest/v1/call_leads?on_conflict=company_key",
        data=body,
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
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
    ap.add_argument("--source", help="only sync leads with this source tag")
    args = ap.parse_args()

    env = load_env()
    url = env.get("OS_SUPABASE_URL")
    key = env.get("OS_SUPABASE_SERVICE_KEY")

    rows = fetch_leads(args.source)
    leads = [to_call_lead(r) for r in rows]
    leads.sort(key=lambda x: -x["score"])

    # Collapse duplicates BEFORE sending. Postgres rejects an upsert whose batch
    # contains the same conflict key twice ("ON CONFLICT DO UPDATE command
    # cannot affect row a second time"), and prospects.db legitimately holds
    # near-duplicate company rows from different scrapes. Highest score wins,
    # since that row carries the richest enrichment.
    deduped: dict[str, dict] = {}
    for l in leads:
        k = (l["company"] or "").strip().lower()
        if not k:
            continue
        if k not in deduped:
            deduped[k] = l
    dropped = len(leads) - len(deduped)
    if dropped:
        print(f"  collapsed {dropped} duplicate company rows before syncing")
    leads = list(deduped.values())

    callable_ = [l for l in leads if not l["excluded"]]
    rejected = [l for l in leads if l["excluded"]]
    print(f"{len(leads)} leads ready to sync"
          + (f" (source={args.source})" if args.source else ""))
    print(f"  {len(callable_)} dialable, {len(rejected)} rejected by the quality pass")
    no_phone = [l for l in callable_ if not l["phone"]]
    if no_phone:
        print(f"  note: {len(no_phone)} dialable leads have no phone and can only be emailed")
    for l in callable_[:10]:
        print(f"  {l['score']:3d}  {l['company'][:40]:40s} {l['phone'] or '(no phone)'}")
    if len(callable_) > 10:
        print(f"  ... and {len(callable_) - 10} more")

    if not args.commit:
        print("\nDRY RUN. Nothing was written. Re-run with --commit to push.")
        return 0

    if not url or not key:
        print("\nERROR: OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY not found in "
              f"{ENV} or the environment. Nothing was pushed.", file=sys.stderr)
        return 1

    # Chunked so one oversized request cannot fail the whole sync.
    sent = 0
    for i in range(0, len(leads), 100):
        chunk = leads[i:i + 100]
        status, err = push(url, key, chunk)
        if status not in (200, 201, 204):
            print(f"\nFAILED on rows {i}-{i + len(chunk)}: HTTP {status} {err}", file=sys.stderr)
            print(f"{sent} leads were pushed before the failure.", file=sys.stderr)
            return 1
        sent += len(chunk)

    # Record the batch so the Sources screen reports facts, not guesses.
    batch = {
        "source": args.source or "mixed",
        "total": len(leads),
        "serviceable": len(callable_),
        "excluded": len(rejected),
    }
    req = urllib.request.Request(
        f"{url}/rest/v1/call_lead_batches",
        data=json.dumps(batch).encode(),
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    try:
        urllib.request.urlopen(req, timeout=30)
    except Exception as e:  # noqa: BLE001
        # The leads are in; a missing batch row is cosmetic, so say so rather
        # than failing a sync that actually worked.
        print(f"  (leads synced, but the batch record failed: {e})", file=sys.stderr)

    print(f"\nPushed {sent} leads into the call room "
          f"({len(callable_)} dialable, {len(rejected)} flagged as rejected).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
