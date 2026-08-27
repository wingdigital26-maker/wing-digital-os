#!/usr/bin/env python3
"""
send_safety_check.py -- Locks in the invariants that today's (2026-08-27)
adversarial-agent finding proved were broken: the Sonar `outbound` table had
RLS disabled and still carried default PostgREST grants to `anon`, meaning
anyone holding the publishable anon key could read every prospect address and
message body, and could INSERT a row with status='approved' that would land
straight in the send queue and get mailed under a real client's name with no
human approval. Migration 0008 fixed the grants and RLS. This script does NOT
find new holes -- it re-checks the specific facts that made this hole possible
and exits non-zero the moment any of them regresses.

WHAT THIS CHECKS
  1. PERMISSIONS   -- anon/authenticated hold no grants on outbound,
                       suppression, client_send_policy, crm_clients, and the
                       outbound_sendable view; RLS is enabled on every real
                       table (views do not carry relrowsecurity themselves --
                       see the note in check 1's output).
  2. DEFAULT DENY  -- client_send_policy exists, and no client absent from it
                       (or present with may_send is not true) can produce a
                       row in outbound_sendable.
  3. SUPPRESSION   -- the suppression table is readable and non-empty, and no
                       address in outbound_sendable appears in it under a
                       case-insensitive, whitespace-trimmed comparison.
  4. VIEW INTEGRITY-- every row the view would hand to a sender is actually
                       status='approved', channel='email', has a non-empty
                       body, a recipient that looks like an email address,
                       and a null sent_at -- checked against the underlying
                       outbound table directly, not just trusted from the
                       view's own SELECT list.
  5. CONTRACT SCOPE-- no client with may_send=false has any row in
                       outbound_sendable, and the set of clients currently
                       permitted to send is printed by name so a change is
                       visible in the output, not silent. No client name is
                       hardcoded in this script's logic.

WHAT THIS DOES NOT PROTECT AGAINST
  This is a regression guard for one already-found hole, not a general
  security scanner. It does not find new classes of vulnerability, does not
  check application code paths (smtp_sender.py, closer, etc.) for bugs that
  bypass outbound_sendable entirely, does not check service-role key handling
  or where that key is stored, does not check Supabase project-level settings
  (network restrictions, JWT secret rotation), and does not check for
  invariants nobody has thought of yet. It only re-verifies what 0008 fixed.

READ ONLY. This script never writes, patches, inserts, or deletes anything.

HOW IT REACHES THE DATABASE
  Data checks (rows) use the read-only Supabase REST API with
  SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY from
  wing-digital-os/.env.local.
  Catalog checks (grants, RLS) use the Supabase Management API
  (POST /v1/projects/{ref}/database/query) with SUPABASE_ACCESS_TOKEN from
  ghl-cli/.env. That endpoint is used here for SELECT-only introspection
  queries -- nothing this script sends can mutate schema or data.

EXIT CODE
  0 if every invariant holds. Non-zero (1) if any invariant fails OR cannot
  be verified. An unverifiable invariant is reported and treated as a
  failure, never as a pass.

USAGE
  python tools/send_safety_check.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
ENV_LOCAL_PATH = ROOT / ".env.local"
GHL_ENV_PATH = ROOT.parent / "ghl-cli" / ".env"
PROJECT_REF = "klzmpjregrcxumaxfsug"
MGMT_QUERY_URL = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"

OUTBOUND_MAIL_TABLES = ["outbound", "suppression", "client_send_policy", "crm_clients"]
OUTBOUND_MAIL_VIEWS = ["outbound_sendable"]

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$")

failures: list[str] = []
verified_count = 0


def fail(check: str, detail: str) -> None:
    failures.append(f"[FAIL] {check}: {detail}")


def unverifiable(check: str, detail: str) -> None:
    failures.append(f"[COULD NOT VERIFY -- treated as failure] {check}: {detail}")


def ok(check: str) -> None:
    global verified_count
    verified_count += 1
    print(f"[PASS] {check}")


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()
    return env


def norm_email(raw: str | None) -> str | None:
    if raw is None:
        return None
    e = raw.strip().lower()
    return e or None


def mgmt_query(sql: str, description: str) -> list[dict] | None:
    """Runs a read-only SQL query via the Supabase Management API. Returns
    None (and records an unverifiable failure) instead of raising, so the
    caller can decide how to report it without ever pretending a pass."""
    token = GHL_ENV.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        unverifiable(description, "SUPABASE_ACCESS_TOKEN missing from ghl-cli/.env")
        return None
    try:
        r = requests.post(
            MGMT_QUERY_URL,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"query": sql},
            timeout=30,
        )
    except requests.RequestException as exc:
        unverifiable(description, f"Management API request failed: {exc}")
        return None
    if r.status_code >= 300:
        unverifiable(description, f"Management API returned {r.status_code}: {r.text[:300]}")
        return None
    try:
        return r.json()
    except ValueError:
        unverifiable(description, "Management API returned non-JSON response")
        return None


def rest_get(base_url: str, key: str, path: str, description: str) -> list[dict] | None:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    out: list[dict] = []
    offset = 0
    page = 1000
    while True:
        headers_r = dict(headers)
        headers_r["Range"] = f"{offset}-{offset + page - 1}"
        try:
            r = requests.get(f"{base_url}/rest/v1/{path}", headers=headers_r, timeout=30)
        except requests.RequestException as exc:
            unverifiable(description, f"REST request failed: {exc}")
            return None
        if r.status_code >= 300:
            unverifiable(description, f"REST returned {r.status_code}: {r.text[:300]}")
            return None
        batch = r.json()
        out.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return out


def check_permissions() -> None:
    """Invariant 1 -- this is the direct regression guard for today's finding:
    outbound had RLS disabled and default PostgREST grants to anon."""
    all_names = OUTBOUND_MAIL_TABLES + OUTBOUND_MAIL_VIEWS
    names_sql = ",".join(f"'{n}'" for n in all_names)

    grants = mgmt_query(
        f"select table_name, grantee, privilege_type from information_schema.role_table_grants "
        f"where table_schema='public' and table_name in ({names_sql}) "
        f"and grantee in ('anon','authenticated') order by table_name, grantee, privilege_type;",
        "PERMISSIONS: role_table_grants for anon/authenticated",
    )
    if grants is None:
        return
    if grants:
        rows = "; ".join(f"{g['table_name']}:{g['grantee']}:{g['privilege_type']}" for g in grants)
        fail("PERMISSIONS", f"anon/authenticated hold grants that should not exist: {rows}")
    else:
        ok(f"PERMISSIONS: anon/authenticated hold no grants on {', '.join(all_names)}")

    rls = mgmt_query(
        f"select c.relname, c.relrowsecurity, c.relkind from pg_class c "
        f"join pg_namespace n on n.oid = c.relnamespace "
        f"where n.nspname='public' and c.relname in ({names_sql});",
        "PERMISSIONS: relrowsecurity for outbound-mail tables/views",
    )
    if rls is None:
        return
    found = {r["relname"]: r for r in rls}
    for t in OUTBOUND_MAIL_TABLES:
        row = found.get(t)
        if row is None:
            fail("PERMISSIONS (RLS)", f"table '{t}' not found in pg_class -- cannot verify RLS")
        elif row["relkind"] != "r":
            fail("PERMISSIONS (RLS)", f"'{t}' is not an ordinary table (relkind={row['relkind']})")
        elif not row["relrowsecurity"]:
            fail("PERMISSIONS (RLS)", f"table '{t}' has row level security DISABLED")
        else:
            ok(f"PERMISSIONS: RLS enabled on table '{t}'")
    for v in OUTBOUND_MAIL_VIEWS:
        row = found.get(v)
        if row is None:
            fail("PERMISSIONS (view)", f"view '{v}' not found in pg_class -- cannot verify it exists")
        elif row["relkind"] != "v":
            fail("PERMISSIONS (view)", f"'{v}' is not a view (relkind={row['relkind']})")
        else:
            print(
                f"[NOTE] '{v}' is a view; relrowsecurity does not apply to views the way it does "
                f"to tables -- its safety comes from having no anon/authenticated grants (checked "
                f"above) and from RLS being enabled on the tables it reads from (also checked above)."
            )


def check_default_deny_and_scope(sendable: list[dict], policy_rows: list[dict]) -> None:
    """Invariant 2 (default deny) and invariant 5 (contract scope). Client
    names are never hardcoded -- they come entirely from client_send_policy
    and from whatever clients actually appear in outbound_sendable."""
    if not policy_rows:
        fail("DEFAULT DENY", "client_send_policy is empty or unreadable -- cannot establish a policy baseline")
        return

    may_send_true = {r["client"] for r in policy_rows if r.get("may_send") is True}
    all_policy_clients = {r["client"] for r in policy_rows if r.get("client")}
    ok(f"DEFAULT DENY: client_send_policy readable, {len(all_policy_clients)} client(s) on record")

    sendable_clients = sorted({r.get("client") for r in sendable if r.get("client")})
    bad_clients = [c for c in sendable_clients if c not in may_send_true]
    if bad_clients:
        fail(
            "DEFAULT DENY / CONTRACT SCOPE",
            f"outbound_sendable contains rows for client(s) without may_send=true: {bad_clients}",
        )
    else:
        ok("DEFAULT DENY: every client appearing in outbound_sendable has may_send=true in client_send_policy")

    print(f"[INFO] Clients currently permitted to send (may_send=true): {sorted(may_send_true) or '(none)'}")
    print(f"[INFO] Clients with at least one row currently in outbound_sendable: {sendable_clients or '(none)'}")


def check_suppression(sendable: list[dict], suppression_rows: list[dict] | None) -> None:
    """Invariant 3."""
    if suppression_rows is None:
        return
    if not suppression_rows:
        fail("SUPPRESSION", "suppression table is readable but empty -- expected at least the seeded entries")
        return
    ok(f"SUPPRESSION: table readable, {len(suppression_rows)} row(s)")

    suppressed = {norm_email(r.get("email")) for r in suppression_rows}
    suppressed.discard(None)

    leaked = []
    for row in sendable:
        addr = norm_email(row.get("to"))
        if addr and addr in suppressed:
            leaked.append(addr)
    if leaked:
        fail("SUPPRESSION", f"outbound_sendable contains suppressed address(es): {sorted(set(leaked))}")
    else:
        ok("SUPPRESSION: no address in outbound_sendable appears in suppression")


def check_view_integrity(sendable: list[dict], outbound_source_rows: list[dict] | None) -> None:
    """Invariant 4 -- checked against the underlying outbound table by id,
    not just trusted from the view's own column list (the view does not even
    expose status/sent_at, so this cross-check is the only way to verify
    those two fields for what is actually in outbound_sendable)."""
    if not sendable:
        print("[NOTE] outbound_sendable is currently empty -- integrity checks below have nothing to check "
              "against, which is consistent with 0008 leaving the queue empty pending real approved sends.")

    bad_shape = []
    for row in sendable:
        to_addr = (row.get("to") or "").strip()
        body = row.get("body") or ""
        if not body.strip():
            bad_shape.append((row.get("id"), "empty body"))
        elif not to_addr or not EMAIL_RE.match(to_addr):
            bad_shape.append((row.get("id"), f"recipient does not look like an email: {to_addr!r}"))
        elif row.get("channel") != "email":
            bad_shape.append((row.get("id"), f"channel is not 'email': {row.get('channel')!r}"))
    if bad_shape:
        fail("VIEW INTEGRITY (shape)", f"{len(bad_shape)} row(s) failed basic shape checks: {bad_shape[:10]}")
    else:
        ok("VIEW INTEGRITY: every outbound_sendable row has a non-empty body, email channel, and email-shaped recipient")

    if outbound_source_rows is None:
        return
    by_id = {r["id"]: r for r in outbound_source_rows}
    mismatches = []
    for row in sendable:
        src = by_id.get(row.get("id"))
        if src is None:
            mismatches.append((row.get("id"), "not found in source outbound table by id"))
            continue
        if src.get("status") != "approved":
            mismatches.append((row.get("id"), f"source status is {src.get('status')!r}, not 'approved'"))
        if src.get("sent_at") is not None:
            mismatches.append((row.get("id"), f"source sent_at is {src.get('sent_at')!r}, not null"))
    if mismatches:
        fail("VIEW INTEGRITY (source cross-check)", f"{len(mismatches)} mismatch(es): {mismatches[:10]}")
    else:
        ok("VIEW INTEGRITY: every outbound_sendable row's source record has status='approved' and sent_at=null")


def main() -> int:
    global GHL_ENV
    env = load_env(ENV_LOCAL_PATH)
    GHL_ENV = load_env(GHL_ENV_PATH)

    sonar_url = env.get("SONAR_SUPABASE_URL")
    sonar_key = env.get("SONAR_SUPABASE_SERVICE_KEY")
    if not sonar_url or not sonar_key:
        print("[FATAL] SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY missing from .env.local")
        return 1

    print("=== send_safety_check.py ===")
    print("Re-verifying the invariants behind the 2026-08-27 outbound RLS/grants finding (fixed by migration 0008).")
    print("This is a regression guard, not a new-hole scanner. Read-only against the database.\n")

    print("--- 1. PERMISSIONS ---")
    check_permissions()

    print("\nFetching outbound_sendable, client_send_policy, suppression via REST (service key, read-only)...")
    sendable = rest_get(sonar_url, sonar_key, "outbound_sendable?select=*", "fetch outbound_sendable")
    policy_rows = rest_get(sonar_url, sonar_key, "client_send_policy?select=client,may_send", "fetch client_send_policy")
    suppression_rows = rest_get(sonar_url, sonar_key, "suppression?select=email", "fetch suppression")

    if sendable is None:
        print("\n[FATAL] Could not read outbound_sendable at all -- every remaining data check below is unverifiable.")
    else:
        print("\n--- 2/5. DEFAULT DENY + CONTRACT SCOPE ---")
        check_default_deny_and_scope(sendable, policy_rows or [])

        print("\n--- 3. SUPPRESSION ---")
        check_suppression(sendable, suppression_rows)

        print("\n--- 4. VIEW INTEGRITY ---")
        ids = [r["id"] for r in sendable if r.get("id")]
        outbound_source_rows = None
        if ids:
            id_list = ",".join(str(i) for i in ids)
            outbound_source_rows = rest_get(
                sonar_url, sonar_key,
                f"outbound?select=id,status,sent_at&id=in.({id_list})",
                "fetch source outbound rows for cross-check",
            )
        else:
            outbound_source_rows = []
        check_view_integrity(sendable, outbound_source_rows)

    print("\n=== RESULT ===")
    if failures:
        for f in failures:
            print(f)
        print(f"\n{len(failures)} invariant(s) failed or could not be verified. {verified_count} passed.")
        return 1
    print(f"All {verified_count} invariant checks passed. Nothing failed, nothing unverifiable.")
    return 0


GHL_ENV: dict[str, str] = {}


if __name__ == "__main__":
    sys.exit(main())
