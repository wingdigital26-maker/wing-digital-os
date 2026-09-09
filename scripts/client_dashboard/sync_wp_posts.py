"""Refresh a client's dashboard post list from their own WordPress site.

The list was a hand-maintained JSON file, so it drifted: Jackson's site had 20
published posts while the dashboard listed 12. Anything published outside this
repo -- or before the file was last touched -- simply never showed up.

This reads the client's live site and rewrites the items file, so the dashboard
reports what is actually on their domain rather than what someone remembered to
add.

    python sync_wp_posts.py --client jackson-roofing

Credentials come from ghl-cli/.env as WP_<SLUG>_URL / _USER / _APP_PASSWORD.
Read-only: this never writes to the client's site.
"""
import argparse
import base64
import html
import io
import json
import os
import re
import sys

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = r"C:\Users\wjack\ghl-cli\.env"


def env():
    out = {}
    with io.open(ENV, encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
            if m:
                out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--client", required=True)
    ap.add_argument("--key", default=None, help="env prefix, default from --client")
    ap.add_argument("--out", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    e = env()
    pre = a.key or ("WP_" + a.client.replace("-", "_").upper())
    url = (e.get(pre + "_URL") or "").rstrip("/")
    user, pw = e.get(pre + "_USER"), e.get(pre + "_APP_PASSWORD")
    if not (url and user and pw):
        raise SystemExit("missing %s_URL / _USER / _APP_PASSWORD in .env" % pre)

    auth = base64.b64encode(("%s:%s" % (user, pw)).encode()).decode()
    H = {"Authorization": "Basic " + auth, "User-Agent": "WingDigital/1.0"}

    posts, page = [], 1
    while True:
        r = requests.get(url + "/wp-json/wp/v2/posts", headers=H, timeout=60,
                         params={"per_page": 100, "page": page, "status": "publish",
                                 "_fields": "slug,title,date,link"})
        if r.status_code != 200:
            raise SystemExit("wp read failed: %s %s" % (r.status_code, r.text[:160]))
        batch = r.json()
        posts += batch
        if len(batch) < 100:
            break
        page += 1

    items = [{
        "date": p["date"][:10],
        "title": html.unescape((p.get("title") or {}).get("rendered", "")).strip(),
        "url": p.get("link") or (url + "/" + p["slug"] + "/"),
    } for p in posts]
    items.sort(key=lambda x: x["date"], reverse=True)

    out = a.out or os.path.join(HERE, "history", "%s-legacy.json" % a.client)
    existing = {}
    if os.path.exists(out):
        existing = json.load(io.open(out, encoding="utf-8"))
    was = len(existing.get("blog_posts", []))

    existing["blog_posts"] = items
    existing["_comment"] = ("Synced from the client's own WordPress site by "
                            "sync_wp_posts.py. Do not hand-edit: it drifted to 12 "
                            "entries while the site had 20, and the dashboard "
                            "under-reported the work for weeks.")

    print("published posts on the site: %d  (items file had %d)" % (len(items), was))
    for it in items[:5]:
        print("   %s  %s" % (it["date"], it["title"][:60]))
    if a.dry_run:
        print("\nDRY RUN -- nothing written")
        return 0
    io.open(out, "w", encoding="utf-8").write(json.dumps(existing, indent=1, ensure_ascii=False))
    print("\nwrote %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
