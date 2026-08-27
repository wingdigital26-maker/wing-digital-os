#!/usr/bin/env python3
"""
sync_suppression.py -- Keep the Sonar `suppression` table (the ONLY table the
cold-email sender reads, via outbound_sendable) in sync with the authoritative
do-not-contact data, which lives in a DIFFERENT Supabase project (the OS
project) and cannot be joined to from Sonar with SQL. This script is the join,
run on a schedule or by hand, instead.

WHY THIS EXISTS
suppression (Sonar project, ref klzmpjregrcxumaxfsug) was seeded by hand once
with 4 addresses. Nothing kept it current. If a contact gets marked
do_not_contact in the OS CRM (OS project, ref ikgnhieorzjaxtjoneye) tomorrow,
the sender has no way to know, because Postgres cannot query across two
separate Supabase projects. This script reads both projects over their REST
APIs and writes the result into the one table the sender trusts.

SOURCES PULLED (all read-only against their origin)
  1. OS crm_contacts where do_not_contact = true and email is not null.
     This is the authoritative opt-out flag. Rows with a NULL email are
     skipped -- there is nothing to suppress -- and counted separately so a
     dry run shows they were seen, not silently dropped.
  2. Client-owned inboxes: any OS crm_contacts row whose business_name
     matches (case-insensitive) a client name in Sonar client_send_policy,
     regardless of that row's do_not_contact flag. A client's own inbox must
     never receive our cold outreach, opted-out or not -- sales@
     brilliantfulfillment.com is exactly this case (Brilliant Fulfillment is
     a client_send_policy row, and their crm_contacts row happens to also be
     flagged do_not_contact, but this pass exists so the guarantee does not
     depend on that flag having been set correctly). Nothing here hardcodes a
     client name -- the match set comes from querying client_send_policy at
     run time.
  3. Role/junk local-parts (info@, sales@, admin@, noreply@, ...), applied
     ONLY to addresses this script actually observed in OS crm_contacts --
     never fabricated. See "ROLE ADDRESSES: PERMANENT SUPPRESSION, ARGUED"
     below for why these go into the permanent table rather than being
     filtered at send time.

NEVER CALLS GOHIGHLEVEL. GHL was retired 2026-08-22 and returns 401 on every
endpoint permanently. The old suppression source (ghl-cli/wing_suppression.py)
scanned GHL for dnd/tag/deliverability signals; that fetch is dead code now.
Its ROLE_JUNK_LOCALPARTS set is still good logic and is reused verbatim below
-- nothing else from that file is touched or imported.

ROLE ADDRESSES: PERMANENT SUPPRESSION, ARGUED
Two ways to keep role/junk addresses (info@, sales@, admin@, noreply@, ...)
out of cold sends: filter them at send time in every sender, or suppress them
permanently here like everything else. This script suppresses them
permanently, for one reason: outbound_sendable and the whole sending contract
(docs/SENDING-CONTRACT.md) were deliberately built so that "safe to send"
reduces to one read of one table -- the suppression list -- not to trusting
every future sender to reimplement the same regex-and-set check correctly.
smtp_sender.py already has its own suppression-file check; a future sender
that skips that check (the exact gap SENDING-CONTRACT.md calls out) would
also skip a send-time role filter, but it CANNOT skip a row that simply is
not sendable in the first place. The cost is a permanent table entry for an
address that was never going to convert anyhow, which is cheap. The
alternative (filter-at-send) would need to be re-implemented in every sender
that ever exists, and the one that forgets it is the one that emails
noreply@ and burns a mailbox's reputation on a bounce. Permanent suppression
loses nothing (nobody is upset that info@ never gets pitched) and removes an
entire class of "did every sender remember the filter" bugs. Permanent wins.

NEVER DELETES. An address that drops out of every source this run stays in
the table -- removing an address is exactly how someone who opted out gets
emailed again by accident. Such addresses are logged as "orphaned" (found
before, not found this run) purely for visibility.

USAGE
  python tools/sync_suppression.py            # dry run (default) -- writes nothing
  python tools/sync_suppression.py --confirm   # writes, upserts on conflict(email)

Reads OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY / SONAR_SUPABASE_URL /
SONAR_SUPABASE_SERVICE_KEY from wing-digital-os/.env.local. Never prints or
logs a key.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env.local"

# Local-parts that are role/junk addresses, never people. Carried over as-is
# from ghl-cli/wing_suppression.py -- that file's GHL fetch is dead (GHL is
# retired and returns 401 permanently), but this set is still correct logic.
ROLE_JUNK_LOCALPARTS = {
    "info", "contact", "office", "admin", "sales", "support", "hello", "team",
    "service", "services", "estimates", "estimating", "billing", "accounts",
    "accounting", "hr", "jobs", "careers", "webmaster", "postmaster", "noreply",
    "no-reply", "donotreply", "marketing", "newsletter", "privacy", "legal",
    "abuse", "help", "enquiries", "inquiries", "mail",
}


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        print(f"[FATAL] {path} not found.")
        sys.exit(1)
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()
    return env


def require(env: dict[str, str], key: str) -> str:
    val = env.get(key)
    if not val:
        print(f"[FATAL] {key} missing from .env.local")
        sys.exit(1)
    return val


def norm_email(raw: str | None) -> str | None:
    if not raw:
        return None
    e = raw.strip().lower()
    if not e or "@" not in e or e.startswith("@") or e.endswith("@"):
        return None
    return e


def rest_get(base_url: str, key: str, path: str) -> list[dict]:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    out: list[dict] = []
    offset = 0
    page = 1000
    while True:
        headers_r = dict(headers)
        headers_r["Range"] = f"{offset}-{offset + page - 1}"
        r = requests.get(f"{base_url}/rest/v1/{path}", headers=headers_r, timeout=30)
        r.raise_for_status()
        batch = r.json()
        out.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return out


def collect_targets(os_url: str, os_key: str, sonar_url: str, sonar_key: str) -> tuple[dict[str, str], dict[str, int]]:
    """Returns (email -> reason) for every address that must never be mailed,
    plus a stats dict for reporting."""
    targets: dict[str, str] = {}
    stats = {"dnc_rows": 0, "dnc_null_email": 0, "client_match_rows": 0, "role_junk_rows": 0}

    def add(email_raw: str | None, reason: str) -> bool:
        e = norm_email(email_raw)
        if not e:
            return False
        # First reason wins the slot but a later distinct reason is appended,
        # so a row that is both do_not_contact AND a client-owned inbox keeps
        # both facts visible instead of silently picking one.
        if e in targets and reason not in targets[e]:
            targets[e] = targets[e] + "; " + reason
        elif e not in targets:
            targets[e] = reason
        return True

    # ---- source 1: OS crm_contacts.do_not_contact ----
    dnc_rows = rest_get(os_url, os_key, "crm_contacts?select=business_name,email,dnc_reason&do_not_contact=eq.true")
    for row in dnc_rows:
        stats["dnc_rows"] += 1
        detail = f" ({row['dnc_reason']})" if row.get("dnc_reason") else ""
        if not add(row.get("email"), f"do_not_contact in OS crm_contacts{detail}"):
            stats["dnc_null_email"] += 1

    # ---- source 2: client-owned inboxes ----
    policy_rows = rest_get(sonar_url, sonar_key, "client_send_policy?select=client")
    client_names = [r["client"] for r in policy_rows if r.get("client")]
    for name in client_names:
        # ilike match on business_name -- data-driven, no client hardcoded here.
        safe = name.replace(",", "").replace("*", "")
        contact_rows = rest_get(
            os_url, os_key,
            f"crm_contacts?select=business_name,email&business_name=ilike.*{requests.utils.quote(safe)}*",
        )
        for row in contact_rows:
            if add(row.get("email"), f"client-owned inbox (matches client_send_policy '{name}')"):
                stats["client_match_rows"] += 1

    # ---- source 3: role/junk local-parts, only among addresses actually seen ----
    all_contact_rows = rest_get(os_url, os_key, "crm_contacts?select=email")
    for row in all_contact_rows:
        e = norm_email(row.get("email"))
        if not e:
            continue
        local = e.split("@", 1)[0]
        if local in ROLE_JUNK_LOCALPARTS:
            if add(e, "role-junk-localpart"):
                stats["role_junk_rows"] += 1

    return targets, stats


def main() -> None:
    confirm = "--confirm" in sys.argv
    env = load_env(ENV_PATH)
    os_url = require(env, "OS_SUPABASE_URL")
    os_key = require(env, "OS_SUPABASE_SERVICE_KEY")
    sonar_url = require(env, "SONAR_SUPABASE_URL")
    sonar_key = require(env, "SONAR_SUPABASE_SERVICE_KEY")

    print("Sources: OS crm_contacts.do_not_contact, OS crm_contacts x Sonar client_send_policy, role-junk localparts")
    print("Reading...")

    targets, stats = collect_targets(os_url, os_key, sonar_url, sonar_key)

    existing_rows = rest_get(sonar_url, sonar_key, "suppression?select=email")
    existing = {norm_email(r["email"]) for r in existing_rows}
    existing.discard(None)

    new_emails = sorted(e for e in targets if e not in existing)
    already_present = sorted(e for e in targets if e in existing)
    orphaned = sorted(existing - set(targets.keys()))

    print()
    print("=== SUMMARY ===")
    print(f"OS crm_contacts rows with do_not_contact=true: {stats['dnc_rows']} (skipped, null email: {stats['dnc_null_email']})")
    print(f"Client-owned inbox matches found:               {stats['client_match_rows']}")
    print(f"Role-junk addresses found in crm_contacts:       {stats['role_junk_rows']}")
    print(f"Total distinct addresses that must be suppressed: {len(targets)}")
    print(f"Already present in Sonar suppression:            {len(already_present)}")
    print(f"New (would be added):                            {len(new_emails)}")
    print(f"Orphaned (in suppression, no longer in any source -- left alone, never deleted): {len(orphaned)}")
    if new_emails:
        print()
        print("New addresses:")
        for e in new_emails:
            print(f"  {e}  <- {targets[e]}")
    if orphaned:
        print()
        print("Orphaned addresses (still suppressed, just no longer in a live source):")
        for e in orphaned:
            print(f"  {e}")

    if not confirm:
        print()
        print(f"(dry run, default -- suppression table unchanged. {len(new_emails)} would be added. Pass --confirm to write.)")
        return

    if not new_emails:
        print()
        print("Nothing new to write. Suppression table unchanged.")
        return

    payload = [{"email": e, "reason": targets[e], "source": "sync_suppression.py"} for e in new_emails]
    headers = {
        "apikey": sonar_key,
        "Authorization": f"Bearer {sonar_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    r = requests.post(f"{sonar_url}/rest/v1/suppression?on_conflict=email", headers=headers, json=payload, timeout=30)
    if r.status_code >= 300:
        print(f"[FATAL] upsert failed: {r.status_code} {r.text[:500]}")
        sys.exit(1)
    print()
    print(f"Wrote {len(new_emails)} new address(es) to Sonar suppression.")


if __name__ == "__main__":
    main()
