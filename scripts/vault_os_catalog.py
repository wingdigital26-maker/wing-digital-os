"""vault_os_catalog.py - snapshot everything happening in the OS into the vault.

Writes ONE page, wiki/os-catalog.md, overwritten each run (like hot.md), and
appends one line to wiki/log.md. The page is the running catalog of OS state:
call room, bookings, reply inbox, sequences, outreach lane, and the recent
os_feed events. No secrets ever touch the vault; this reads env from
C:\\Users\\wjack\\ghl-cli\\.env and writes only derived business data.

Run:  python scripts/vault_os_catalog.py          (writes the page)
Cron: safe to run on any schedule; every run is a full overwrite.
"""
import os, sys, json, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

ENV_PATH = r"C:\Users\wjack\ghl-cli\.env"
VAULT = r"C:\Users\wjack\OneDrive\Documentos\Obsidian 2.0\Jacks Ai Brain 2.0"
PAGE = os.path.join(VAULT, "wiki", "os-catalog.md")
LOG = os.path.join(VAULT, "wiki", "log.md")


def load_env(path):
    env = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


ENV = load_env(ENV_PATH)
# Sonar creds live under different names depending on the env file; fill gaps
# from the OS app's .env.local without overwriting anything already set.
for k, v in load_env(r"C:\Users\wjack\wing-digital-os\.env.local").items():
    ENV.setdefault(k, v)


def rest(base_key, service_key, path, count=False):
    """GET one PostgREST path. Returns (rows, total) or (None, None) on failure."""
    url, key = ENV.get(base_key), ENV.get(service_key)
    if not url or not key:
        return None, None
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if count:
        headers["Prefer"] = "count=exact"
    req = urllib.request.Request(f"{url}/rest/v1/{path}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            rows = json.loads(r.read().decode() or "[]")
            total = None
            cr = r.headers.get("Content-Range", "")
            if "/" in cr and cr.split("/")[1].isdigit():
                total = int(cr.split("/")[1])
            return rows, total
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
        return None, None


def os_get(path, count=False):
    return rest("OS_SUPABASE_URL", "OS_SUPABASE_SERVICE_KEY", path, count)


def sonar_get(path, count=False):
    return rest("SONAR_SUPABASE_URL", "SONAR_SUPABASE_SERVICE_KEY", path, count)


def line_counts(rows, field):
    out = {}
    for r in rows or []:
        out[r.get(field) or "none"] = out.get(r.get(field) or "none", 0) + 1
    return out


def main():
    now = datetime.now()
    # UTC 'Z' form: PostgREST filter values with '+00:00' break unless encoded.
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    sections = []
    missing = []

    # Call room
    leads, lead_total = os_get("call_leads?select=status,assigned_to_email&limit=5000", count=True)
    if leads is None:
        missing.append("call room (OS Supabase unreachable)")
    else:
        by_status = line_counts(leads, "status")
        by_owner = line_counts([r for r in leads if r.get("assigned_to_email")], "assigned_to_email")
        acts, act_total = os_get(f"call_activity?select=outcome&created_at=gte.{week_ago}&limit=2000", count=True)
        sections.append(
            "## Call Room\n"
            f"- Leads: {lead_total or len(leads)} total. By status: "
            + ", ".join(f"{k} {v}" for k, v in sorted(by_status.items())) + "\n"
            + ("- Assigned sheets: " + ", ".join(f"{k} {v}" for k, v in by_owner.items()) + "\n" if by_owner else "- Assigned sheets: none yet\n")
            + (f"- Calls logged this week: {act_total if act_total is not None else 'unknown'}"
               + (" (" + ", ".join(f"{k} {v}" for k, v in sorted(line_counts(acts, 'outcome').items())) + ")" if acts else "")
               + "\n")
        )

    # Bookings
    bookings, _ = os_get("bookings?select=name,starts_at,status&status=neq.cancelled&starts_at=gte.now()&order=starts_at.asc&limit=20")
    if bookings is None:
        missing.append("bookings")
    else:
        rows = "".join(f"- {b['starts_at'][:16].replace('T', ' ')} UTC: {b['name']} ({b['status']})\n" for b in bookings)
        sections.append("## Upcoming Bookings\n" + (rows or "- None on the calendar right now\n"))

    # Reply inbox
    replies, reply_total = os_get("reply_triage?select=classification,status&limit=2000", count=True)
    if replies is None:
        missing.append("reply inbox")
    else:
        needs = sum(1 for r in replies if r.get("status") in ("none", "draft"))
        sections.append(
            "## Reply Inbox\n"
            f"- {reply_total or len(replies)} replies tracked, {needs} need attention. By class: "
            + (", ".join(f"{k} {v}" for k, v in sorted(line_counts(replies, 'classification').items())) or "none")
            + "\n"
        )

    # Sequences
    seqs, _ = os_get("sequences?select=name,status")
    enr, enr_total = os_get("sequence_enrollments?select=status&limit=2000", count=True)
    if seqs is None:
        missing.append("sequences")
    else:
        sections.append(
            "## Sequences\n"
            + ("".join(f"- {s['name']}: {s['status']}\n" for s in seqs) or "- No sequences yet\n")
            + (f"- Enrollments: {enr_total or 0} total ("
               + ", ".join(f"{k} {v}" for k, v in sorted(line_counts(enr, 'status').items())) + ")\n" if enr else "")
        )

    # Outreach lane (Sonar)
    _, sendable = sonar_get("outbound_sendable?select=id&limit=1", count=True)
    _, suppressed = sonar_get("suppression?select=email&limit=1", count=True)
    if sendable is None:
        missing.append("outreach lane (Sonar)")
    else:
        sections.append(
            "## Outreach Lane\n"
            f"- Send-ready queue: {sendable}. Suppression list: {suppressed if suppressed is not None else 'unknown'}.\n"
            "- Cloud sender: paused by Jack since 2026-08-16.\n"
        )

    # OS feed
    feed, _ = os_get("os_feed?select=agent,title,created_at&order=created_at.desc&limit=25")
    if feed is None:
        missing.append("os_feed")
    else:
        rows = "".join(f"- {f['created_at'][:16].replace('T', ' ')} [{f['agent']}] {f['title']}\n" for f in feed)
        sections.append("## Recent OS Events (os_feed)\n" + (rows or "- Feed is empty\n"))

    stamp = now.strftime("%Y-%m-%d %H:%M")
    page = (
        "---\n"
        "title: OS Catalog (live snapshot)\n"
        "tags:\n  - wing-digital\n  - os\n  - catalog\n"
        f"updated: {now.strftime('%Y-%m-%d')}\n"
        "status: auto-generated\n"
        "---\n\n"
        "# OS Catalog\n\n"
        f"> Auto-generated snapshot of everything live in the Wing OS, taken {stamp}.\n"
        "> Overwritten on every run of `wing-digital-os/scripts/vault_os_catalog.py`. Do not hand-edit.\n\n"
        + "\n".join(sections)
        + ("\n## Sources Not Reachable This Run\n" + "".join(f"- {m}\n" for m in missing) if missing else "")
    )
    os.makedirs(os.path.dirname(PAGE), exist_ok=True)
    with open(PAGE, "w", encoding="utf-8") as f:
        f.write(page)

    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"\n## [{now.strftime('%Y-%m-%d')}] build | os-catalog snapshot refreshed ({stamp}), sources missing: {len(missing)}\n")
    print(f"Wrote {PAGE} ({len(sections)} sections, {len(missing)} sources unreachable)")


if __name__ == "__main__":
    main()
