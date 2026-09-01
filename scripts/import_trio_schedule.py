#!/usr/bin/env python3
"""One-time import of the trio's class schedules into calendar_blocks.

Source: the published Schedule Hub repo (github.com/wingdigital26-maker/schedule).
Each app keeps its class data inside a marked block:

    /* ==DATA:START== */ ... const COURSES = [ ... ] /* ==DATA:END== */

We fetch each person's built page live, parse the COURSES literal, and turn
every recurring class meeting into one calendar_blocks row per weekday:
person, category='study', recurrence='weekly', date = first on-or-after the
semester start that falls on that weekday, times from the course itself.

WHO IS WHO (from the repo README's own table):
    root (index.html)  -> jack
    b/index.html       -> maddox
    c/index.html       -> "Schedule C" — the repo does NOT name a person.
                          Skipped by default rather than guessed. Pass
                          --c-as grant (or team) to import it deliberately.

Idempotent: every imported row carries notes='trio-import'; each run first
deletes all rows with that tag before inserting.

Dry-run by default. Pass --commit to write.
Env: OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY from C:/Users/wjack/ghl-cli/.env
(values are never printed).
"""
import argparse
import datetime as dt
import json
import re
import sys
import urllib.request

ENV_PATH = r"C:\Users\wjack\ghl-cli\.env"
BASE = "https://wingdigital26-maker.github.io/schedule/"
PAGES = {"jack": "", "maddox": "b/", "c": "c/"}
DAY_LETTER = {"U": 6, "M": 0, "T": 1, "W": 2, "R": 3, "F": 4, "S": 5}  # python weekday: Mon=0
TAG = "trio-import"


def load_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def fetch(url):
    req = urllib.request.Request(url + f"?x={int(dt.datetime.now().timestamp())}",
                                 headers={"Cache-Control": "no-cache", "User-Agent": "trio-import"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def parse_data_block(html):
    m = re.search(r"/\* ==DATA:START== \*/([\s\S]*?)/\* ==DATA:END== \*/", html)
    if not m:
        return None
    block = m.group(1)

    def grab(name):
        h = re.search(rf"const\s+{name}\s*=\s*", block)
        if not h:
            return None
        i = h.end()
        open_ch = block[i]
        close_ch = {"{": "}", "[": "]"}.get(open_ch)
        if not close_ch:
            return None
        depth, in_str, j = 0, False, i
        while j < len(block):
            ch = block[j]
            if in_str:
                if ch == "\\":
                    j += 1
                elif ch == "'":
                    in_str = False
            elif ch == "'":
                in_str = True
            elif ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    return literal_to_json(block[i:j + 1])
            j += 1
        return None

    return {"semester": grab("SEMESTER"), "courses": grab("COURSES")}


def literal_to_json(src):
    s = src.strip()
    # strip // comments not inside strings
    s = re.sub(r"'(?:[^'\\]|\\.)*'|//[^\n]*", lambda m: m.group(0) if m.group(0).startswith("'") else "", s)
    # single -> double quoted strings
    s = re.sub(r"'((?:[^'\\]|\\.)*)'",
               lambda m: '"' + m.group(1).replace("\\'", "'").replace('"', '\\"') + '"', s)
    # bare keys
    s = re.sub(r'"(?:[^"\\]|\\.)*"|([{,]\s*)([A-Za-z_$][\w$]*)\s*:',
               lambda m: f'{m.group(1)}"{m.group(2)}":' if m.group(2) else m.group(0), s)
    # trailing commas
    s = re.sub(r",(\s*[}\]])", r"\1", s)
    return json.loads(s)


def rows_for(person, data):
    sem = data.get("semester") or {}
    start_s = sem.get("start")
    if not start_s:
        raise ValueError(f"{person}: no semester start date in the DATA block")
    sem_start = dt.date.fromisoformat(start_s)
    rows = []
    for c in data.get("courses") or []:
        title = (c.get("short") or c.get("title") or "").strip()
        days = (c.get("days") or "").upper()
        st, en = c.get("start"), c.get("end")
        if not title or not days or not st or not en:
            print(f"  ! skipped course with missing fields: {c.get('title')!r}")
            continue
        for ch in days:
            wd = DAY_LETTER.get(ch)
            if wd is None:
                continue
            anchor = sem_start + dt.timedelta(days=(wd - sem_start.weekday()) % 7)
            rows.append({
                "title": title,
                "person": person,
                "date": anchor.isoformat(),
                "start_time": st + ":00",
                "end_time": en + ":00",
                "category": "study",
                "recurrence": "weekly",
                "notes": TAG,
            })
    return rows


def sb(env, method, path, body=None):
    url = env["OS_SUPABASE_URL"].rstrip("/") + "/rest/v1/" + path
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("apikey", env["OS_SUPABASE_SERVICE_KEY"])
    req.add_header("Authorization", "Bearer " + env["OS_SUPABASE_SERVICE_KEY"])
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8")
        return json.loads(raw) if raw else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="actually write (default: dry run)")
    ap.add_argument("--c-as", choices=["grant", "team"], default=None,
                    help="import Schedule C as this person (skipped by default — the repo does not name its owner)")
    args = ap.parse_args()

    env = load_env(ENV_PATH)
    if not env.get("OS_SUPABASE_URL") or not env.get("OS_SUPABASE_SERVICE_KEY"):
        print("Missing OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY in ghl-cli/.env")
        sys.exit(1)

    all_rows = []
    for who, sub in PAGES.items():
        if who == "c" and not args.c_as:
            print("Schedule C: SKIPPED — the repo names it only 'Schedule C', not a person. "
                  "Re-run with --c-as grant to import it as Grant.")
            continue
        person = args.c_as if who == "c" else who
        html = fetch(BASE + sub)
        data = parse_data_block(html)
        if not data or not data.get("courses"):
            print(f"{who}: no parseable DATA block at {BASE + sub} — skipped, nothing invented.")
            continue
        rows = rows_for(person, data)
        print(f"{who} -> person '{person}': {len(rows)} weekly blocks "
              f"from {len(data['courses'])} courses")
        for r in rows:
            print(f"    {r['date']} {r['start_time'][:5]}-{r['end_time'][:5]}  {r['title']}")
        all_rows.extend(rows)

    if not args.commit:
        print(f"\nDRY RUN: would delete prior '{TAG}' rows and insert {len(all_rows)} rows. "
              "Re-run with --commit to write.")
        return

    deleted = sb(env, "DELETE", f"calendar_blocks?notes=eq.{TAG}")
    print(f"\nDeleted {len(deleted)} prior {TAG} rows.")
    if all_rows:
        inserted = sb(env, "POST", "calendar_blocks", all_rows)
        print(f"Inserted {len(inserted)} rows.")
        per = {}
        for r in inserted:
            per[r["person"]] = per.get(r["person"], 0) + 1
        for p, n in sorted(per.items()):
            print(f"  {p}: {n}")
    else:
        print("Nothing to insert.")


if __name__ == "__main__":
    main()
