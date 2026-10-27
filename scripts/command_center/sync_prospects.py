#!/usr/bin/env python3
"""
Push the cold-call prospect list from Jack's laptop up to the Wing Command Center.

    prospects.db  (C:\\Users\\wjack\\ghl-cli\\prospects.db, opened READ-ONLY)
        -> POST {COMMAND_URL}/api/command/prospects/sync   (Bearer COMMAND_MACHINE_KEY)

Rules it keeps:
  * prospects.db is opened with mode=ro. This script never writes to it.
  * Only rows with a phone or email go up, and never rows with an excluded_reason.
  * Upserts on the prospects.db id ("db:<id>"), so re-running updates rows and
    never duplicates them. Call outcomes, notes and next-call dates live in the
    cloud and are never overwritten by a sync.
  * Timestamps in prospects.db are ISO strings; they are passed through as-is.

Usage (from the wing-digital-os folder on the laptop):
    python scripts\\command_center\\sync_prospects.py            # dry run: shows what would go
    python scripts\\command_center\\sync_prospects.py --commit   # actually push
    python scripts\\command_center\\sync_prospects.py --commit --vertical roofing --limit 500

Settings (read from the environment, else from C:\\Users\\wjack\\ghl-cli\\.env):
    COMMAND_URL          e.g. https://<your deployment>.vercel.app   (no trailing slash)
    COMMAND_MACHINE_KEY  the same value set on Vercel
    PROSPECTS_DB         optional override of the database path
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

DEFAULT_DB = r"C:\Users\wjack\ghl-cli\prospects.db"
ENV_FILE = r"C:\Users\wjack\ghl-cli\.env"
BATCH = 500

# prospects.db column -> Command Center field. First existing column wins.
COLUMNS = {
    "business": ["name", "company", "business_name"],
    "contact": ["owner_name", "contact_name", "owner"],
    "phone": ["phone", "phone_number"],
    "email": ["email"],
    "website": ["website", "url"],
    "city": ["city"],
    "niche": ["vertical", "trade", "niche", "industry"],
    "hook": ["call_hook", "hook"],
}


def load_env() -> dict:
    out = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("COMMAND_URL", "COMMAND_MACHINE_KEY", "PROSPECTS_DB"):
        if os.environ.get(k):
            out[k] = os.environ[k]
    return out


def read_rows(db_path: str, vertical: str | None, limit: int | None) -> list[dict]:
    # mode=ro: SQLite refuses any write on this handle, so the master list is safe.
    uri = "file:" + db_path.replace("\\", "/") + "?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    db.row_factory = sqlite3.Row
    cols = {r["name"] for r in db.execute("PRAGMA table_info(prospects)")}
    if not cols:
        sys.exit("No prospects table found in " + db_path)
    pick = {field: next((c for c in names if c in cols), None) for field, names in COLUMNS.items()}
    if not pick["business"] or not (pick["phone"] or pick["email"]):
        sys.exit("prospects table is missing a name or phone/email column")

    where = []
    reach = []
    if pick["phone"]:
        reach.append(f"({pick['phone']} IS NOT NULL AND {pick['phone']} <> '')")
    if pick["email"]:
        reach.append(f"({pick['email']} IS NOT NULL AND {pick['email']} <> '')")
    where.append("(" + " OR ".join(reach) + ")")
    if "excluded_reason" in cols:
        where.append("(excluded_reason IS NULL OR excluded_reason = '')")
    args: list = []
    if vertical and pick["niche"]:
        where.append(f"lower({pick['niche']}) LIKE ?")
        args.append(f"%{vertical.lower()}%")
    order = "updated_at DESC" if "updated_at" in cols else "rowid DESC"
    sql = f"SELECT rowid AS _rowid, * FROM prospects WHERE {' AND '.join(where)} ORDER BY {order}"
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = []
    for r in db.execute(sql, args):
        d = dict(r)
        pid = d.get("id", d["_rowid"])
        row = {"id": f"db:{pid}"}
        for field, col in pick.items():
            if col and d.get(col) not in (None, ""):
                row[field] = str(d[col]).strip()
        rows.append(row)
    db.close()
    return rows


def post(url: str, key: str, rows: list[dict]) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps({"rows": rows}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")[:300]
        sys.exit(f"Command Center refused the sync: HTTP {e.code} {body}")
    except urllib.error.URLError as e:
        sys.exit(f"Could not reach the Command Center: {e.reason}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--commit", action="store_true", help="actually push (default is a dry run)")
    ap.add_argument("--vertical", help="only rows whose vertical contains this, e.g. roofing")
    ap.add_argument("--limit", type=int, help="at most this many rows")
    ap.add_argument("--db", help="path to prospects.db")
    a = ap.parse_args()

    env = load_env()
    db_path = a.db or env.get("PROSPECTS_DB") or DEFAULT_DB
    if not os.path.exists(db_path):
        sys.exit(f"prospects.db not found at {db_path}")
    rows = read_rows(db_path, a.vertical, a.limit)
    print(f"{len(rows)} prospects ready from {db_path}")
    for r in rows[:5]:
        print("  ", r.get("business"), "|", r.get("phone") or r.get("email"), "|", r.get("city", ""))
    if not a.commit:
        print("Dry run. Add --commit to push.")
        return

    base = (env.get("COMMAND_URL") or "").rstrip("/")
    key = env.get("COMMAND_MACHINE_KEY") or ""
    if not base or not key:
        sys.exit("Set COMMAND_URL and COMMAND_MACHINE_KEY (environment or ghl-cli .env) first.")
    totals = {"added": 0, "updated": 0, "skipped": 0}
    for i in range(0, len(rows), BATCH):
        res = post(f"{base}/api/command/prospects/sync", key, rows[i : i + BATCH])
        for k in totals:
            totals[k] += int(res.get(k, 0))
        print(f"  batch {i // BATCH + 1}: {res}")
    print(f"Done. Added {totals['added']}, updated {totals['updated']}, skipped {totals['skipped']}.")


if __name__ == "__main__":
    main()
