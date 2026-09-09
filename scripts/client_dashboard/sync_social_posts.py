"""Pull a client's Instagram posts into their dashboard items file.

Reads through the Meta MCP export that the assistant fetches (ads_get_ig_media),
saved to a JSON file, and turns it into dashboard items so social work shows up
next to the blog work instead of being invisible.

Only posts from --since forward are included, so a client's own older posts are
not claimed as agency work.

    python sync_social_posts.py --client jackson-roofing \\
        --media ig_media.json --since 2026-07-01
"""
import argparse
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def first_line(caption, limit=95):
    """A usable title: the first real sentence, hashtags and emoji trimmed."""
    text = (caption or "").strip()
    text = re.sub(r"#\w+", "", text)
    text = re.sub(r"[\U0001F300-\U0001FAFF☀-➿✔️]", "", text)
    for line in text.split("\n"):
        line = line.strip(" -–—•\t")
        if len(line) > 12:
            return (line[:limit].rstrip() + "…") if len(line) > limit else line
    return "Instagram post"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--client", required=True)
    ap.add_argument("--media", required=True, help="JSON array from ads_get_ig_media")
    ap.add_argument("--since", default="2026-07-01")
    ap.add_argument("--out", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    raw = json.load(io.open(a.media, encoding="utf-8"))
    if isinstance(raw, dict):
        raw = raw.get("ig_media") or []
    if isinstance(raw, str):
        raw = json.loads(raw)

    items = []
    for m in raw:
        ts = (m.get("timestamp") or "")[:10]
        if not ts or ts < a.since:
            continue
        items.append({
            "date": ts,
            "title": first_line(m.get("caption")),
            "url": m.get("permalink"),
            "kind": "REEL" if m.get("media_product_type") == "REELS" else "POST",
        })
    items.sort(key=lambda x: x["date"], reverse=True)

    out = a.out or os.path.join(HERE, "history", "%s-legacy.json" % a.client)
    data = json.load(io.open(out, encoding="utf-8")) if os.path.exists(out) else {}
    was = len(data.get("social_posts", []))
    data["social_posts"] = items
    data["_social_comment"] = (
        "Instagram posts published from %s forward, read from the client's own "
        "account. Older posts are the client's own and are deliberately excluded "
        "so agency work is never overstated." % a.since)

    print("instagram posts since %s: %d  (file had %d)" % (a.since, len(items), was))
    for it in items[:6]:
        print("   %s  %-5s %s" % (it["date"], it["kind"], it["title"][:60]))
    if a.dry_run:
        print("\nDRY RUN -- nothing written")
        return 0
    io.open(out, "w", encoding="utf-8").write(json.dumps(data, indent=1, ensure_ascii=False))
    print("\nwrote %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
