#!/usr/bin/env python3
"""
queue_review_requests.py -- the missing piece upstream of app/api/reviews/send:
finds jobs that finished 30-60 minutes ago and inserts a `queued` row into
public.reviews for the contact, so the (still-disabled) send route has
something to eventually deliver.

THIS SCRIPT ONLY EVER INSERTS `queued` ROWS. It never calls /api/sms/send or
/api/email/send, never flips REVIEWS_SEND_ENABLED, and is NOT wired to any
cron/scheduled task by this change -- per the review-request-sms spec, that
switch stays a deliberate decision Jack makes separately (A2P 10DLC gate).
Run it by hand to see what it would queue; nothing fires automatically until
someone schedules it AND arms the send route.

JOB-COMPLETE SIGNAL: public.bookings.status = 'completed' (0017_bookings_
sequences.sql) is the only "a job just finished" signal that exists in this
schema today -- Cold Call Room / CRM has no other job-close field. A booking
has no contact_id column (it stores name/email/phone directly, source
public_link | manual | call_room), so this script resolves the matching
crm_contacts row by exact phone (E.164-normalised) or, failing that,
lower-cased email, and skips the booking (uncounted, logged as unmatched) if
neither resolves a contact. This is a known scope gap -- confirm-path per the
spec was never fully closed (bookings is one candidate signal, not the only
possible "job done" event) -- and is exactly why this stays a script someone
runs and reads, not a live trigger.

GATES, IN ORDER, ALL FAIL CLOSED:
  1. Client must have clients.google_review_url set (migration 0034). No
     link on file -> never queued for that client, period.
  2. Contact must resolve (see above) and crm_contacts.do_not_contact must
     be false.
  3. No un-revoked opt-out: the newest public.consent row for that contact's
     phone (channel='sms') or email (channel='email') must not have a
     revoked_at with no later granted_at -- i.e. respect inbound STOP-word
     handling (app/api/sms/inbound) even though nothing yet writes that back
     to crm_contacts.do_not_contact. This is the gap section 4 of the spec
     calls out explicitly: a contact who opts out between queue-time and
     send-time must not still show as "held", so we check the same consent
     ledger the STOP handler writes, not just the do_not_contact flag.
  4. Per-contact cap: skip if that contact already has ANY reviews row
     (queued/requested/received/dismissed) created in the last 90 days,
     across any job -- repeat customers don't get asked every visit.
  5. Per-client daily cap: skip once a client already has
     REVIEW_DAILY_CAP_PER_CLIENT (default 25) reviews rows created today
     (any status) -- a lightweight cap in this script's own terms rather than
     importing ghl-cli/send_caps.py, which is purpose-built for the B2B cold-
     outreach enqueue ledger (outbound_ledger.jsonl) and has no notion of
     `reviews` rows; re-implementing its exact ledger-counting shape here for
     a different table would be more fragile than this direct COUNT-style
     check against the table that already IS the source of truth.
  6. One request per completed job, ever: skip if a reviews row already
     exists for this exact booking (tracked via `notes` = "booking:<id>",
     since reviews has no booking_id column and adding one is out of scope
     for a stub).

Usage:
    python scripts/queue_review_requests.py             # dry run (default)
    python scripts/queue_review_requests.py --commit     # actually insert
    python scripts/queue_review_requests.py --client-slug heros-junk-removal
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env.local"

WINDOW_MIN_MINUTES = 30
WINDOW_MAX_MINUTES = 60
PER_CONTACT_COOLDOWN_DAYS = 90
DEFAULT_DAILY_CAP_PER_CLIENT = 25


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("OS_SUPABASE_URL", "OS_SUPABASE_SERVICE_KEY"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def require(env: dict[str, str], key: str) -> str:
    val = env.get(key)
    if not val:
        print(f"[FATAL] {key} missing from .env.local")
        sys.exit(1)
    return val


def rest(base_url: str, key: str, method: str, path: str, body=None):
    url = f"{base_url}/rest/v1/{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    if method == "POST":
        req.add_header("Prefer", "return=representation")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")[:400]
        print(f"[FATAL] {method} {path} -> {e.code}: {detail}")
        sys.exit(1)


def norm_phone(raw: str | None) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if raw.strip().startswith("+") and len(digits) >= 8:
        return f"+{digits}"
    return None


def norm_email(raw: str | None) -> str | None:
    if not raw:
        return None
    e = raw.strip().lower()
    return e if "@" in e else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="actually insert queued rows (default: dry run)")
    ap.add_argument("--client-slug", help="only consider bookings for this client_slug")
    args = ap.parse_args()

    env = load_env(ENV_PATH)
    url = require(env, "OS_SUPABASE_URL")
    key = require(env, "OS_SUPABASE_SERVICE_KEY")
    daily_cap = int(env.get("REVIEW_DAILY_CAP_PER_CLIENT", DEFAULT_DAILY_CAP_PER_CLIENT))

    now = datetime.now(timezone.utc)
    window_start = (now - timedelta(minutes=WINDOW_MAX_MINUTES)).isoformat()
    window_end = (now - timedelta(minutes=WINDOW_MIN_MINUTES)).isoformat()

    slug_filter = f"&client_slug=eq.{args.client_slug}" if args.client_slug else ""
    bookings = rest(
        url, key, "GET",
        "bookings?select=id,name,email,phone,client_slug,status,starts_at"
        f"&status=eq.completed&starts_at=gte.{window_start}&starts_at=lte.{window_end}{slug_filter}",
    )

    print(f"Window: jobs completed between {window_start} and {window_end} UTC ({WINDOW_MIN_MINUTES}-{WINDOW_MAX_MINUTES} min ago).")
    print(f"Bookings in window: {len(bookings)}")

    if not bookings:
        print("Nothing to queue.")
        return

    client_cache: dict[str, dict] = {}

    def client_info(slug: str) -> dict:
        if slug in client_cache:
            return client_cache[slug]
        rows = rest(url, key, "GET", f"clients?select=slug,google_review_url&slug=eq.{slug}&limit=1")
        info = {"google_review_url": (rows[0].get("google_review_url") if rows else None)}
        client_cache[slug] = info
        return info

    to_insert = []
    skipped = {"no_link": 0, "no_contact": 0, "dnc": 0, "opted_out": 0, "cooldown": 0, "daily_cap": 0, "already_queued": 0}
    daily_counts: dict[str, int] = {}
    queued_contact_ids_this_run: set = set()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

    for b in bookings:
        slug = b.get("client_slug")
        if not slug:
            skipped["no_contact"] += 1
            continue

        info = client_info(slug)
        if not (info.get("google_review_url") or "").strip():
            skipped["no_link"] += 1
            continue

        # Gate 6: one request per job, ever.
        already = rest(url, key, "GET", f"reviews?select=id&notes=eq.booking:{b['id']}&limit=1")
        if already:
            skipped["already_queued"] += 1
            continue

        # Gate 5: per-client daily cap (count today's rows once per client).
        if slug not in daily_counts:
            today_rows = rest(url, key, "GET", f"reviews?select=id&client_slug=eq.{slug}&created_at=gte.{today_start}")
            daily_counts[slug] = len(today_rows)
        if daily_counts[slug] >= daily_cap:
            skipped["daily_cap"] += 1
            continue

        phone = norm_phone(b.get("phone"))
        email = norm_email(b.get("email"))
        contact = None
        if phone:
            phone_q = urllib.parse.quote(phone, safe="")
            rows = rest(url, key, "GET", f"crm_contacts?select=id,do_not_contact,phone,email&phone=eq.{phone_q}&limit=1")
            contact = rows[0] if rows else None
        if not contact and email:
            email_q = urllib.parse.quote(email, safe="")
            rows = rest(url, key, "GET", f"crm_contacts?select=id,do_not_contact,phone,email&email=eq.{email_q}&limit=1")
            contact = rows[0] if rows else None
        if not contact:
            skipped["no_contact"] += 1
            continue
        if contact.get("do_not_contact"):
            skipped["dnc"] += 1
            continue

        # Gate 3: respect an inbound STOP even though do_not_contact hasn't
        # caught up to it yet. Look for the newest consent row per address.
        opted_out = False
        for addr, channel in ((phone, "sms"), (email, "email")):
            if not addr:
                continue
            addr_q = urllib.parse.quote(addr, safe="")
            rows = rest(
                url, key, "GET",
                f"consent?select=granted_at,revoked_at&address=eq.{addr_q}&channel=eq.{channel}&order=id.desc&limit=1",
            )
            if rows:
                latest = rows[0]
                if latest.get("revoked_at") and not latest.get("granted_at"):
                    opted_out = True
                elif latest.get("revoked_at") and latest.get("granted_at") and latest["revoked_at"] > latest["granted_at"]:
                    opted_out = True
        if opted_out:
            skipped["opted_out"] += 1
            continue

        # Gate 4: 90-day per-contact cooldown across any job/client. Checks
        # committed DB rows only, so also guard against two bookings for the
        # same contact landing in this same run (they haven't been POSTed
        # yet, so the DB query above wouldn't see each other).
        if contact["id"] in queued_contact_ids_this_run:
            skipped["cooldown"] += 1
            continue

        cooldown_start = (now - timedelta(days=PER_CONTACT_COOLDOWN_DAYS)).isoformat()
        recent = rest(
            url, key, "GET",
            f"reviews?select=id&contact_id=eq.{contact['id']}&created_at=gte.{cooldown_start}&limit=1",
        )
        if recent:
            skipped["cooldown"] += 1
            continue

        channel = "sms" if phone else "email"
        to_insert.append({
            "client_slug": slug,
            "contact_id": contact["id"],
            "channel": channel,
            "status": "queued",
            "notes": f"booking:{b['id']}",
        })
        daily_counts[slug] = daily_counts.get(slug, 0) + 1
        queued_contact_ids_this_run.add(contact["id"])

    print(f"Would queue: {len(to_insert)}")
    print(f"Skipped: {skipped}")

    if not args.commit:
        print("\n(dry run, default -- reviews table unchanged. Pass --commit to insert.)")
        return

    if not to_insert:
        print("\nNothing to insert.")
        return

    rest(url, key, "POST", "reviews", to_insert)
    print(f"\nInserted {len(to_insert)} queued review row(s). Sending stays gated on REVIEWS_SEND_ENABLED.")


if __name__ == "__main__":
    main()
