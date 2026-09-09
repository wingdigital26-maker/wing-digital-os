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
from html import unescape
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
            # "&amp;" in a <title> is an ENTITY, not the text. Left as-is it is
            # escaped a second time by the page and the client reads "&amp;".
            txt = unescape(txt)
            # Trim the "| Brand Name" tail that <title> tags carry.
            txt = re.split(r"\s+[|–—]\s+", txt)[0].strip()
            if txt:
                return txt
    return fallback_name.rsplit(".", 1)[0].replace("-", " ").title()


def from_items_file(src):
    """A plain JSON record of work that no live source can be read for.

    Generic on purpose: point `path` at a JSON file, `key` at the list inside
    it, and every entry supplies its own date/title/url. `type` and `status`
    default the rows. Used for HISTORICAL work whose site we can no longer
    reach (a retired CMS, a host that blocks us), so the record survives even
    though nothing can re-verify it today. It states only what was published
    and when; it never claims the URL was checked on this build.
    """
    path = src["path"]
    if not os.path.isabs(path):
        path = os.path.join(HERE, path)
    if not os.path.exists(path):
        print("    ! items file missing: %s" % path)
        return []
    note_mtime(path)
    with open(path, encoding="utf-8") as fh:
        blob = json.load(fh)
    rows = blob.get(src.get("key", "items")) or []
    items = []
    for e in rows:
        if not e.get("date") or not e.get("title"):
            continue
        items.append({
            "date": e["date"],
            "type": e.get("type") or src.get("type") or "other",
            "title": e["title"],
            "status": e.get("status") or src.get("status") or "published",
            "url": e.get("url") or "",
        })
    return items


SOURCES = {"state_file": from_state_file, "git_repo": from_git_repo,
           "items_file": from_items_file}


# ── outreach: only what is actually shipping ─────────────────────────────────
def live_channels_only(outreach):
    """HOUSE RULE: a dashboard shows what is GOING OUT and nothing else.

    Non-live channels are stripped from the payload entirely, not merely hidden
    in the template, so a client reading the page source still never finds a
    list of what they do not have. Configs keep every channel so the internal
    record stays complete; only the shipped page is filtered.
    """
    if not outreach:
        return {}
    out = dict(outreach)
    chans = [c for c in (outreach.get("channels") or []) if c.get("state") == "live"]
    out["channels"] = chans
    if not chans:
        out.pop("intro", None)
    return out


# ── outreach preview (client-approval view of a pending email program) ───────
def parse_outreach_templates(path):
    """Parse an outreach templates.md into per-category email blocks.

    Expected shape (generic, not client-specific): "## <n>. Category" headings,
    each holding one or more "**Stage**" blocks that start with "Subject: ..."
    followed by the body. Sections without such blocks (variant lists, reply
    snippets) are skipped. Missing file -> None, so the page can say so.
    """
    if not os.path.exists(path):
        print("    ! outreach templates missing: %s" % path)
        return None
    note_mtime(path)
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    cats = []
    for sec in re.split(r"^## +", text, flags=re.M)[1:]:
        lines = sec.splitlines()
        name = re.sub(r"^\d+\.\s*", "", lines[0]).strip()
        emails, stage, subject, body = [], None, None, []
        def flush():
            if stage and subject:
                emails.append({"stage": stage, "subject": subject,
                               "body": "\n".join(body).strip()})
        for ln in lines[1:]:
            m = re.match(r"^\*\*(.+?)\*\*\s*$", ln.strip())
            if m:
                flush()
                stage, subject, body = m.group(1), None, []
                continue
            if stage and subject is None:
                sm = re.match(r"^Subject:\s*(.+)$", ln.strip())
                if sm:
                    subject = sm.group(1).strip()
                continue
            if stage and subject is not None:
                if ln.strip() == "---":
                    break
                body.append(ln)
        flush()
        if emails:
            cats.append({"name": name, "emails": emails})
    return cats


def mask_email(addr, mask=None):
    """j***@domain.com -- the client sees who, never a harvestable address.

    A dashboard link gets texted and forwarded, so it is effectively public. Any
    section that shows contacts runs its addresses through here first; a full
    address must never reach the built HTML. Shape is config-driven via an
    optional {"keep": <chars of the local part>, "fill": "<what replaces the
    rest>"} block, so a section can choose its own look without a second copy of
    this function existing anywhere.
    """
    addr = (addr or "").strip()
    if "@" not in addr:
        return ""
    mask = mask or {}
    keep = max(0, int(mask.get("keep", 1)))
    fill = mask.get("fill", "***")
    local, domain = addr.split("@", 1)
    head = local[:keep]
    if not head:
        head = "*"
    return head + fill + "@" + domain


def load_send_queue(path):
    """Send-queue CSV -> client-safe rows: company, category, city, masked email.
    Internal scoring/status columns are deliberately not carried across."""
    if not os.path.exists(path):
        print("    ! send queue missing: %s" % path)
        return None
    note_mtime(path)
    import csv
    rows = []
    # utf-8-sig: a BOM would otherwise hide the first column behind "﻿email"
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            rows.append({
                "company": (r.get("company") or "").strip(),
                "category": (r.get("category") or "").strip(),
                "city": (r.get("city") or "").strip(),
                "email": mask_email(r.get("email")),
            })
    return rows


def collect_outreach_preview(cfg):
    op = cfg.get("outreachPreview")
    if not op:
        return None
    data = {
        "intro": op.get("intro", ""),
        "banner": op.get("banner", ""),
        "plan": op.get("plan", []),
        "templatesNote": op.get("templates_note", ""),
        "queueNote": op.get("queue_note", ""),
        "categories": None,
        "queue": None,
    }
    if op.get("templates_md"):
        data["categories"] = parse_outreach_templates(op["templates_md"])
    if op.get("queue_csv"):
        data["queue"] = load_send_queue(op["queue_csv"])
    return data


# ── storm history (a read-only summary of a public storm record) ─────────────
def collect_storm_history(cfg):
    """Summarise a storm-record data file for the dashboard.

    Generic on purpose: the config names the JSON file and supplies all of the
    copy, so any weather-driven trade gets the same section. Returns None when
    the config omits the key, and the template then renders nothing at all.

    Honesty rules enforced here rather than left to the template:
      * Nothing is computed, modelled or extrapolated. Every number emitted is
        read straight out of the source file, which is itself a copy of a
        public record. There is no "homes affected", "roofs damaged" or
        revenue figure, because the source does not contain one.
      * The source URL and the pull date travel with the payload so the page
        can print them and the client can check the record himself.
      * The event list is only sliced, never re-ordered by anything the source
        does not already say.
    """
    sh = cfg.get("stormHistory")
    if not sh:
        return None
    path = sh["data"]
    if not os.path.isabs(path):
        path = os.path.join(HERE, path)
    if not os.path.exists(path):
        print("    ! storm data missing: %s" % path)
        return None
    note_mtime(path)
    with open(path, encoding="utf-8") as fh:
        src = json.load(fh)
    meta = src.get("_comment", {})
    events = src.get("events", [])
    top_n = sh.get("topEvents", 10)
    # Biggest hail first, then most recent. Both keys come from the source.
    top = sorted(events, key=lambda e: (-(e.get("hailInches") or 0),
                                        e.get("date") or ""))[:top_n]
    return {
        "title": sh.get("title", "Storm history in your service area"),
        "intro": sh.get("intro", ""),
        "banner": sh.get("banner", ""),
        "note": sh.get("note", ""),
        "sourceLine": sh.get("source_line", ""),
        "sourceUrl": meta.get("databaseHomepage") or meta.get("sourceUrl"),
        "pulledOn": meta.get("pulledOn"),
        "coverageNote": meta.get("coverageNote", ""),
        "window": src.get("window", {}),
        "summary": src.get("summary", {}),
        "byCounty": src.get("byCounty", []),
        "byMonth": src.get("byMonth", []),
        "byServiceCity": src.get("byServiceCity", []),
        "citiesWithNoNamedReport": src.get("serviceCitiesWithNoNamedReport", []),
        "cityNote": src.get("serviceCityNote", ""),
        "topEvents": top,
        "labels": sh.get("labels", {}),
        "mapUrl": sh.get("mapUrl"),
        "mapLabel": sh.get("mapLabel"),
        "mapNote": sh.get("mapNote"),
    }


# ── review standing (a live read of public review listings) ──────────────────
def collect_review_standing(cfg):
    """Summarise a review-standing data file for the dashboard.

    Generic on purpose: the config names the JSON file and supplies all of the
    copy, so any client with a public review profile gets the same section.
    Returns None when the config omits the key, and the template then renders
    nothing at all.

    Honesty rules enforced here rather than left to the template:
      * Nothing is computed beyond arithmetic on figures that are already in
        the source file. There is no ranking forecast, lead figure or revenue
        figure, because the source does not contain one.
      * The pull date and the per-figure source note travel with the payload so
        the page can print them and the client can check the listings himself.
      * Competitors are only sorted by a number the source already carries.
    """
    rs = cfg.get("reviewStanding")
    if not rs:
        return None
    path = rs["data"]
    if not os.path.isabs(path):
        path = os.path.join(HERE, path)
    if not os.path.exists(path):
        print("    ! review standing data missing: %s" % path)
        return None
    note_mtime(path)
    with open(path, encoding="utf-8") as fh:
        src = json.load(fh)
    meta = src.get("_comment", {})
    comps = sorted(src.get("competitors", []),
                   key=lambda c: -(c.get("reviewCount") or 0))
    return {
        "title": rs.get("title", "Where you stand on reviews"),
        "intro": rs.get("intro", ""),
        "banner": rs.get("banner", ""),
        "note": rs.get("note", ""),
        "sourceLine": rs.get("source_line", ""),
        "pulledOn": meta.get("pulledOn"),
        "honesty": meta.get("honesty", ""),
        "client": src.get("client", {}),
        "competitors": comps,
        "summary": src.get("summary", {}),
        "dropped": meta.get("dropped", []),
        "labels": rs.get("labels", {}),
    }


# ── referral partners (a staged, never-contacted list, summarised) ───────────
def collect_referral_partners(cfg):
    """Summarise a staged partner list out of a SQLite table.

    Generic on purpose: the config names the database, the table and the column
    map, so any client with a list of businesses who could send them work gets
    the same section. Returns None when the config omits the key, and the
    template then renders nothing at all.

    Three honesty rules are enforced here rather than left to the template:
      * Every address is masked (see mask_email). The built page is texted, so a
        full address in it is a published address.
      * `hiddenCategories` are dropped from the VISIBLE breakdown but stay in
        the headline total, and the payload reports how many were held back so
        the page can say so out loud instead of quietly losing rows.
      * Nothing here is a projection. Only counts that come straight off the
        table are emitted; response, conversion and revenue figures do not
        exist in the source and are not invented on the way out.
    """
    rp = cfg.get("referralPartners")
    if not rp:
        return None
    import sqlite3
    path = rp["db"]
    if not os.path.exists(path):
        print("    ! partner db missing: %s" % path)
        return None
    note_mtime(path)
    table = rp.get("table", "leads")
    mask = rp.get("emailMask")
    hidden = set(rp.get("hiddenCategories", []))
    labels = rp.get("categoryLabels", {})

    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute("SELECT * FROM %s" % table)]
    con.close()

    def has(r, col):
        return bool((r.get(col) or "").strip())

    # excludeCategories removes rows from the dataset ENTIRELY, headline total
    # included, so every number on the page reconciles with no disclosure note.
    # hiddenCategories is the softer, older behaviour: out of the breakdown but
    # still inside the total, which then has to be explained on the page.
    excluded = set(rp.get("excludeCategories", []))
    if excluded:
        rows = [r for r in rows if (r.get("category") or "") not in excluded]
    total = len(rows)
    visible = [r for r in rows if (r.get("category") or "") not in hidden]

    cats = {}
    for r in visible:
        c = r.get("category") or "other"
        cats[c] = cats.get(c, 0) + 1
    categories = [{"key": k, "label": labels.get(k, k.replace("-", " ").title()),
                   "count": v}
                  for k, v in sorted(cats.items(), key=lambda kv: -kv[1])]

    city_counts = {}
    for r in visible:
        if has(r, "email") and (r.get("city") or "").strip():
            city_counts[r["city"].strip()] = city_counts.get(r["city"].strip(), 0) + 1
    cities = [{"city": c, "count": n}
              for c, n in sorted(city_counts.items(), key=lambda kv: (-kv[1], kv[0]))
              ][: int(rp.get("topCities", 8))]

    # Sample rows: real records, spread across the visible categories so the
    # sample is not eight of the same thing. Verified addresses first.
    pool = [r for r in visible if (r.get("email_status") or "") == "ok" and has(r, "email")]
    if len(pool) < int(rp.get("sampleSize", 10)):
        pool = [r for r in visible if has(r, "email") or has(r, "phone")]
    by_cat = {}
    for r in sorted(pool, key=lambda r: (-(r.get("reviews") or 0), r.get("name") or "")):
        by_cat.setdefault(r.get("category") or "other", []).append(r)
    sample, order = [], [c["key"] for c in categories if c["key"] in by_cat]
    while order and len(sample) < int(rp.get("sampleSize", 10)):
        for c in list(order):
            if not by_cat[c]:
                order.remove(c)
                continue
            sample.append(by_cat[c].pop(0))
            if len(sample) >= int(rp.get("sampleSize", 10)):
                break
    sample = [{
        "name": (r.get("name") or "").strip(),
        "category": labels.get(r.get("category") or "", (r.get("category") or "").replace("-", " ").title()),
        "city": (r.get("city") or "").strip(),
        "email": mask_email(r.get("email"), mask),
        "phone": (r.get("phone") or "").strip(),
    } for r in sample]

    return {
        "title": rp.get("title", "Who could send you work"),
        "statLabel": rp.get("statLabel", ""),
        "intro": rp.get("intro", ""),
        "banner": rp.get("banner", ""),
        "note": rp.get("note", ""),
        "sampleNote": rp.get("sample_note", ""),
        "total": total,
        "hiddenCount": total - len(visible),
        "unique": sum(1 for r in rows if (r.get("status") or "") != "duplicate-org"),
        "withEmail": sum(1 for r in rows if has(r, "email")),
        "verifiedEmail": sum(1 for r in rows if (r.get("email_status") or "") == "ok"),
        "withPhone": sum(1 for r in rows if has(r, "phone")),
        "namedContact": sum(1 for r in rows if has(r, "contact_name")),
        "cityCount": len({(r.get("city") or "").strip() for r in rows if (r.get("city") or "").strip()}),
        "categories": categories,
        "cities": cities,
        "sample": sample,
    }


def collect_pages(cfg, items):
    """Live-page groups for the Pages tab, read off the real site repo."""
    out = []
    # A live URL belongs on this tab once. The same page can be read off the
    # site repo AND recorded by a content item; listing it in two groups would
    # inflate the "pages live on your site" count the client can check by hand.
    seen_urls = set()
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
            url = base + "/" + rel
            key = url.rstrip("/").lower()
            if key in seen_urls:
                continue
            seen_urls.add(key)
            links.append({
                "title": page_title(os.path.join(directory, name), name),
                "url": url,
            })
        if links:
            out.append({"group": grp["group"], "icon": grp.get("icon", "file"), "links": links})
    # Some clients have no local repo (site lives on WordPress) -- fall back to
    # the URLs the content items themselves recorded, grouped by content type.
    for grp in cfg.get("pages_from_items", []):
        links = []
        for it in items:
            if it["type"] not in grp["types"] or not it.get("url"):
                continue
            key = it["url"].rstrip("/").lower()
            if key in seen_urls:
                continue
            seen_urls.add(key)
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
    items = sorted(merged.values(), key=lambda i: i["date"])

    # De-dupe on URL as well. A scheduler that re-ran the same piece writes the
    # same URL under two dates; listing it twice inflates the count and the
    # client can catch it by clicking both rows. Keep the FIRST publish date,
    # which is the one that is true.
    by_url, out = {}, []
    for it in items:
        u = (it.get("url") or "").strip().rstrip("/").lower()
        if not u:
            out.append(it)
            continue
        if u in by_url:
            continue
        by_url[u] = it
        out.append(it)
    items = sorted(out, key=lambda i: i["date"], reverse=True)

    # The content record is only as current as the OLDEST source feeding it.
    # Reporting "as of today" on a state file nobody has written in three weeks
    # tells the client the silence is real when it is just a stale file.
    data = {
        # Who this dashboard belongs to. The referral-partner lookup keys off it,
        # so a dashboard can only ever ask for its OWN client's list.
        "slug": slug,
        "generated": date.today().isoformat(),
        "dataThrough": min(SOURCE_MTIMES) if SOURCE_MTIMES else None,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "brand": cfg["brand"],
        "engines": cfg.get("engines", []),
        "types": cfg.get("types", {}),
        "showChart": cfg.get("showChart", True),
        "outreach": live_channels_only(cfg.get("outreach", {})),
        "outreachPreview": collect_outreach_preview(cfg),
        # Optional, generic: a forward-looking "what happens next" block.
        # Intentions only -- the template renders no counts or results from
        # it, and it disappears entirely when a config omits the key.
        "plan": cfg.get("plan"),
        # Optional, generic: a staged partner list summarised from a database.
        # Absent key -> no section at all. Addresses are masked before they get
        # anywhere near the HTML.
        "referralPartners": collect_referral_partners(cfg),
        # Optional, generic: a summary of a public storm/weather record file.
        # Absent key -> no section at all. Counts only, straight off the source.
        "stormHistory": collect_storm_history(cfg),
        # Optional, generic: a summary of a live read of public review listings.
        # Absent key -> no section at all. Figures straight off the source, plus
        # arithmetic (median, range, gap) on those same figures. No projection.
        "reviewStanding": collect_review_standing(cfg),
        # Optional, generic: per-section copy overrides (see template).
        "notes": cfg.get("notes", {}),
        # Optional REAL numbers only (e.g. {"emailsSent30d": 120, "asOf": "2026-09-06"}).
        # Nimbus's arrival reaction reads these; leaving it absent is always
        # honest, inventing a number here never is.
        "metrics": cfg.get("metrics", {}),
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
    # The Artifact CSP blocks non-CDN external scripts, so the root-relative
    # /mascot/wing-mascot.js tag would silently never load there. Inline it.
    # Only the mascot component. The public marketing knowledge base names
    # other Wing clients, so it must never be inlined into a client page.
    for fname in ("wing-mascot.js",):
        src = os.path.join(HERE, "..", "..", "public", "mascot", fname)
        if not os.path.exists(src):
            continue
        with open(src, encoding="utf-8") as fh:
            js = fh.read().replace("</script>", "<\\/script>")
        for tag in ('<script src="/mascot/%s"></script>' % fname,
                    '<script src="/mascot/%s?v=1"></script>' % fname,
                    '<script src="/mascot/%s?v=12"></script>' % fname):
            art = art.replace(tag, "<script>\n%s\n</script>" % js)
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
