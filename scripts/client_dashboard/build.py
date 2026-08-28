#!/usr/bin/env python3
"""
build.py -- Wing Digital interactive client dashboards.

One template, one config per client, one self-contained HTML file out. No client
specifics live in this file or in template.html; everything is in clients/*.json
so the same engine serves every client we sign.

Usage:
    python build.py                 # rebuild every client in clients/
    python build.py heros-junk      # rebuild one

Output: wing-digital-os/public/dashboards/<slug>.html
The output is fully self-contained (data inlined). It works logged out, from a
file:// path, and with the PC off once it is hosted or published as an Artifact.

HONESTY RULE: this script only emits facts it can read off disk. Content items
come from a real content-engine state file or from real git history in the site
repo. Metrics with no source are listed in "pendingMetrics" and rendered as
"not connected", never as a zero that a client would read as "we did nothing".
"""
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "template.html")
CLIENTS = os.path.join(HERE, "clients")
OUT_DIR = os.path.join(HERE, "..", "..", "public", "dashboards")


# ── sources ──────────────────────────────────────────────────────────────────
SOURCE_MTIMES = []


def note_mtime(path):
    """Track when each source was last WRITTEN, so the page can say how fresh
    its record actually is instead of stamping itself with today's date."""
    try:
        SOURCE_MTIMES.append(date.fromtimestamp(os.path.getmtime(path)).isoformat())
    except OSError:
        pass


def from_state_file(src):
    """Content-engine state JSON: {"YYYY-MM-DD": [{type,title,status,url}, ...]}."""
    path = src["path"]
    if not os.path.exists(path):
        print("    ! state file missing: %s" % path)
        return []
    note_mtime(path)
    with open(path, encoding="utf-8") as fh:
        state = json.load(fh)
    items = []
    for day, entries in state.items():
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(day)):
            continue
        for e in entries or []:
            items.append({
                "date": day,
                "type": e.get("type") or "other",
                "title": e.get("title") or (e.get("type") or "Item"),
                "status": e.get("status") or "planned",
                "url": e.get("url") or "",
            })
    return items


def from_git_repo(src):
    """Real publish dates from a static site repo: first commit that ADDED each file.

    Uses --diff-filter=A so a later edit never masquerades as a publish date.
    """
    repo = src["repo"]
    if not os.path.isdir(os.path.join(repo, ".git")):
        print("    ! not a git repo: %s" % repo)
        return []
    # A git repo is read live, so its record is current as of this build.
    SOURCE_MTIMES.append(date.today().isoformat())
    items = []
    for grp in src["globs"]:
        pattern = grp["glob"]
        directory = os.path.join(repo, os.path.dirname(pattern))
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".html") or name in grp.get("skip", []):
                continue
            rel = os.path.join(os.path.dirname(pattern), name).replace("\\", "/")
            added = subprocess.run(
                ["git", "log", "--diff-filter=A", "--format=%as", "-1", "--", rel],
                cwd=repo, capture_output=True, text=True,
            ).stdout.strip()
            if not added:
                continue
            items.append({
                "date": added,
                "type": grp["type"],
                "title": page_title(os.path.join(directory, name), name),
                "status": "published",
                "url": src["base_url"].rstrip("/") + "/" + rel,
            })
    return items


TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.I | re.S)


def page_title(path, fallback_name):
    """Prefer the page's own <h1>, then <title>, then a slug-derived name."""
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            html = fh.read()
    except OSError:
        html = ""
    for rx in (H1_RE, TITLE_RE):
        m = rx.search(html)
        if m:
            txt = re.sub(r"<[^>]+>", "", m.group(1))
            txt = re.sub(r"\s+", " ", txt).strip()
            # Trim the "| Brand Name" tail that <title> tags carry.
            txt = re.split(r"\s+[|–—]\s+", txt)[0].strip()
            if txt:
                return txt
    return fallback_name.rsplit(".", 1)[0].replace("-", " ").title()


SOURCES = {"state_file": from_state_file, "git_repo": from_git_repo}


def collect_pages(cfg, items):
    """Live-page groups for the Pages tab, read off the real site repo."""
    out = []
    for grp in cfg.get("pages", []):
        repo, base = grp["repo"], grp["base_url"].rstrip("/")
        directory = os.path.join(repo, grp["dir"]) if grp["dir"] else repo
        if not os.path.isdir(directory):
            continue
        links = []
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".html") or name in grp.get("skip", []):
                continue
            rel = (grp["dir"] + "/" + name if grp["dir"] else name).replace("\\", "/")
            links.append({
                "title": page_title(os.path.join(directory, name), name),
                "url": base + "/" + rel,
            })
        if links:
            out.append({"group": grp["group"], "icon": grp.get("icon", "file"), "links": links})
    # Some clients have no local repo (site lives on WordPress) -- fall back to
    # the URLs the content items themselves recorded, grouped by content type.
    for grp in cfg.get("pages_from_items", []):
        seen, links = set(), []
        for it in items:
            if it["type"] in grp["types"] and it.get("url") and it["url"] not in seen:
                seen.add(it["url"])
                links.append({"title": it["title"], "url": it["url"]})
        if links:
            out.append({"group": grp["group"], "icon": grp.get("icon", "file"), "links": links})
    return out


def build(slug):
    cfg_path = os.path.join(CLIENTS, slug + ".json")
    with open(cfg_path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    print("  building %s" % slug)
    SOURCE_MTIMES.clear()   # per-client; a multi-client run must not pool these

    items = []
    for src in cfg.get("sources", []):
        fn = SOURCES.get(src["kind"])
        if not fn:
            print("    ! unknown source kind: %s" % src["kind"])
            continue
        got = fn(src)
        print("    %s -> %d items" % (src["kind"], len(got)))
        items.extend(got)

    # De-dupe on (date, title): the same piece can appear in a state file and in
    # git history. Keep whichever record carries a URL.
    merged = {}
    for it in items:
        key = (it["date"], it["title"].lower())
        if key not in merged or (it.get("url") and not merged[key].get("url")):
            merged[key] = it
    items = sorted(merged.values(), key=lambda i: i["date"], reverse=True)

    # The content record is only as current as the OLDEST source feeding it.
    # Reporting "as of today" on a state file nobody has written in three weeks
    # tells the client the silence is real when it is just a stale file.
    data = {
        "generated": date.today().isoformat(),
        "dataThrough": min(SOURCE_MTIMES) if SOURCE_MTIMES else None,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "brand": cfg["brand"],
        "engines": cfg.get("engines", []),
        "types": cfg.get("types", {}),
        "outreach": cfg.get("outreach", {}),
        "pendingMetrics": cfg.get("pendingMetrics", []),
        "items": items,
        "pages": collect_pages(cfg, items),
    }

    with open(TEMPLATE, encoding="utf-8") as fh:
        html = fh.read()
    theme = cfg.get("theme", {})
    subs = {
        "__TITLE__": cfg["brand"]["name"] + " | Client Dashboard",
        "__ACCENT__": theme.get("accent", "#e8a33d"),
        "__ACCENT2__": theme.get("accent2", "#f0c274"),
        "__ACCENT_BG__": theme.get("accent_bg", "rgba(232,163,61,.11)"),
        "__ACCENT_GLOW__": theme.get("accent_glow", "rgba(232,163,61,.18)"),
        "__ACCENT_L__": theme.get("accent_light", theme.get("accent", "#c9821c")),
        "__ACCENT2_L__": theme.get("accent2_light", theme.get("accent2", "#f0c274")),
        "__ACCENT_BG_L__": theme.get("accent_bg_light", "rgba(201,130,28,.09)"),
        "__ACCENT_GLOW_L__": theme.get("accent_glow_light", "rgba(201,130,28,.13)"),
        # The initials badge: the brand's dark tile and letter colour, identical
        # in both themes so it can never flip to an unreadable pairing.
        "__MARK_BG__": theme.get("mark_bg", theme.get("accent_light", "#1c1a17")),
        "__MARK_FG__": theme.get("mark_fg", "#ffffff"),
    }
    for k, v in subs.items():
        html = html.replace(k, v)
    html = html.replace("__DATA__", json.dumps(data, separators=(",", ":")))

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, slug + ".html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    # Artifact variant: the Artifact publisher supplies its own
    # <!doctype>/<html>/<head>/<body> shell, so this copy carries only the page
    # content (title, styles, markup, script) with the outer tags removed.
    art = html
    for tag in ("<!DOCTYPE html>", '<html lang="en">', "</html>",
                "<head>", "</head>", "<body>", "</body>"):
        art = art.replace(tag, "")
    art = "\n".join(ln for ln in art.splitlines() if ln.strip() != "")
    # In the Artifact gallery the title is the page's NAME, sat beside dozens of
    # others -- so it carries the client, not the word "dashboard" twice over.
    art = art.replace("<title>%s</title>" % subs["__TITLE__"],
                      "<title>%s Dashboard</title>" % cfg["brand"]["name"])
    art_path = os.path.join(OUT_DIR, slug + ".artifact.html")
    with open(art_path, "w", encoding="utf-8") as fh:
        fh.write(art)

    pages_n = sum(len(g["links"]) for g in data["pages"])
    pub_n = sum(1 for i in items if i["status"] == "published")
    print("    -> %s (%d items, %d published, %d live pages)"
          % (out, len(items), pub_n, pages_n))
    return out


if __name__ == "__main__":
    slugs = sys.argv[1:] or [
        f[:-5] for f in sorted(os.listdir(CLIENTS)) if f.endswith(".json")
    ]
    for s in slugs:
        build(s)
