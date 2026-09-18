"""Run every call_leads.contact_name through real_name.clean_name().

Inbox/business "names" ("Orders", "Jerryssigns") become NULL so the lead drops
off the dial list until a real person is found; messy real names are tidied
("Mr. Steve Hill, President" -> "Steve Hill"). Dry by default.

    python scripts/clean_call_lead_names.py            # report only
    python scripts/clean_call_lead_names.py --commit   # back up, then write

The backup (id + original name) is written before any patch, so every change
is reversible.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from real_name import clean_name  # noqa: E402

ENV = Path(__file__).resolve().parent.parent / ".env.local"
FALLBACK_ENV = Path(r"C:\Users\wjack\wing-digital-os\.env.local")
ARCHIVE = Path(r"C:\Users\wjack\_archive")


def env() -> tuple[str, str]:
    vals: dict[str, str] = {}
    src = ENV if ENV.exists() else FALLBACK_ENV
    for line in src.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip('"')
    return vals["OS_SUPABASE_URL"], vals["OS_SUPABASE_SERVICE_KEY"]


def call(url: str, key: str, method: str = "GET", body: dict | None = None):
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    a = ap.parse_args()
    url, key = env()

    rows: list[dict] = []
    offset = 0
    while True:
        page = call(
            f"{url}/rest/v1/call_leads?select=id,company,contact_name"
            f"&contact_name=not.is.null&order=id&limit=1000&offset={offset}",
            key,
        )
        rows += page
        if len(page) < 1000:
            break
        offset += 1000

    changes = []
    for r in rows:
        new = clean_name(r["contact_name"])
        if new != r["contact_name"]:
            changes.append({**r, "new": new})

    nulled = sum(1 for c in changes if c["new"] is None)
    print(f"{len(rows)} named rows; {nulled} -> NULL, {len(changes) - nulled} tidied")
    if not a.commit:
        print("dry run. --commit to write.")
        return 0

    ARCHIVE.mkdir(exist_ok=True)
    backup = ARCHIVE / f"call-lead-names-{dt.date.today().isoformat()}.json"
    backup.write_text(json.dumps(changes, indent=1), encoding="utf-8")
    print(f"backup -> {backup}")

    failed = 0
    for c in changes:
        try:
            call(
                f"{url}/rest/v1/call_leads?id=eq.{urllib.parse.quote(c['id'])}",
                key,
                "PATCH",
                {"contact_name": c["new"]},
            )
        except Exception as e:  # noqa: BLE001
            failed += 1
            print("FAIL", c["company"], e)
    print(f"patched {len(changes) - failed}, failed {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
