"""storm_watch.py - SPC hail report watcher for the DFW storm-response demo lane.

Fetches NOAA SPC filtered hail report CSVs, filters to reports within
~80 miles of DFW (32.9, -96.9) in Texas, maps each report to affected
ZIPs (storm_map.py), and upserts rows into OS Supabase storm_events.

DEMO-ONLY HARD RULE: this script writes database rows and nothing else.
It never posts to any platform, never creates an ad, never calls any
Meta/Nextdoor/social API, and never spends anything.

Time convention (verified against spc.noaa.gov/climo/reports/today.html,
"All Times UTC"): report times are HHMM UTC, and an SPC "day" YYMMDD runs
1200 UTC on that date through 1159 UTC the NEXT date. So a time < 1200
belongs to the calendar day AFTER the file's date.

Usage:
  python storm_watch.py                 # today's file, dry run
  python storm_watch.py --date 260526   # a past SPC day (YYMMDD)
  python storm_watch.py --backfill 30   # scan the last 30 SPC days
  python storm_watch.py --backfill 30 --stop-first  # stop at first day with DFW hits
  add --commit to actually upsert into Supabase
"""

import argparse
import csv
import io
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from storm_map import affected_zips, haversine_mi  # noqa: E402

DFW_LAT, DFW_LON = 32.9, -96.9
DFW_RADIUS_MI = 80.0
SPC_BASE = "https://www.spc.noaa.gov/climo/reports/"
ENV_PATH = r"C:\Users\wjack\ghl-cli\.env"


def load_env(path=ENV_PATH):
    env = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    except OSError:
        pass
    # real environment wins
    env.update({k: v for k, v in os.environ.items() if k.startswith("OS_SUPABASE")})
    return env


def supabase_request(env, path, method="GET", body=None, extra_headers=None):
    url = env["OS_SUPABASE_URL"].rstrip("/") + "/rest/v1/" + path
    key = env["OS_SUPABASE_SERVICE_KEY"]
    headers = {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw.strip() else None


def fetch_csv(day):
    """day: None for today, else 'YYMMDD'. Returns CSV text or None on 404."""
    name = "today_filtered_hail.csv" if day is None else "%s_rpts_filtered_hail.csv" % day
    req = urllib.request.Request(SPC_BASE + name, headers={"User-Agent": "wing-storm-watch/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def spc_day_str(day):
    """The YYMMDD this fetch represents (today's file = current SPC day)."""
    if day is not None:
        return day
    now = datetime.now(timezone.utc)
    if now.hour < 12:  # before 1200Z we are still in yesterday's SPC day
        now -= timedelta(days=1)
    return now.strftime("%y%m%d")


def parse_reports(csv_text, day_yymmdd):
    """Parse SPC hail CSV into DFW-filtered event dicts."""
    events = []
    base_date = datetime.strptime(day_yymmdd, "%y%m%d").replace(tzinfo=timezone.utc)
    reader = csv.DictReader(io.StringIO(csv_text))
    for row in reader:
        try:
            t = row["Time"].strip()
            lat = float(row["Lat"])
            lon = float(row["Lon"])
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if row.get("State", "").strip().upper() != "TX":
            continue
        if haversine_mi(DFW_LAT, DFW_LON, lat, lon) > DFW_RADIUS_MI:
            continue
        if not (len(t) == 4 and t.isdigit()):
            continue
        hh, mm = int(t[:2]), int(t[2:])
        if hh > 23 or mm > 59:
            continue
        # SPC day runs 1200Z..1159Z next day: times before 1200Z are next calendar day
        d = base_date + timedelta(days=1 if hh < 12 else 0)
        event_time = d.replace(hour=hh, minute=mm)
        size_raw = row.get("Size", "").strip()
        size_in = None
        if size_raw.isdigit() and int(size_raw) > 0:
            size_in = round(int(size_raw) / 100.0, 2)  # hundredths of an inch
        events.append({
            "event_time": event_time.isoformat(),
            "lat": lat,
            "lon": lon,
            "size_in": size_in,
            "location": (row.get("Location") or "").strip() or None,
            "county": (row.get("County") or "").strip() or None,
            "state": "TX",
            "affected": affected_zips(lat, lon),
            "source": "spc",
            "source_key": "spc:%s:%s:%.4f:%.4f" % (day_yymmdd, t, lat, lon),
            "raw": dict(row),
        })
    return events


def upsert_events(env, events):
    if not events:
        return 0
    supabase_request(
        env,
        "storm_events?on_conflict=source_key",
        method="POST",
        body=events,
        extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
    )
    return len(events)


def main():
    ap = argparse.ArgumentParser(description="SPC hail watcher (DFW, demo-only)")
    ap.add_argument("--date", help="SPC day YYMMDD (default: today)")
    ap.add_argument("--backfill", type=int, default=0, help="scan the last N SPC days")
    ap.add_argument("--stop-first", action="store_true",
                    help="with --backfill: stop at the most recent day with DFW hits")
    ap.add_argument("--commit", action="store_true", help="write to Supabase (default dry run)")
    args = ap.parse_args()

    env = load_env()
    if args.commit and not (env.get("OS_SUPABASE_URL") and env.get("OS_SUPABASE_SERVICE_KEY")):
        print("Missing OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY; aborting.")
        sys.exit(1)

    days = []
    if args.backfill:
        today = spc_day_str(None)
        base = datetime.strptime(today, "%y%m%d")
        days = [(base - timedelta(days=i)).strftime("%y%m%d") for i in range(args.backfill)]
    else:
        days = [args.date or None]

    total = 0
    for day in days:
        day_str = spc_day_str(day)
        csv_text = fetch_csv(day)
        if csv_text is None:
            print("%s: no file (404)" % day_str)
            continue
        events = parse_reports(csv_text, day_str)
        if not events:
            print("%s: 0 DFW hail reports" % day_str)
            continue
        print("%s: %d DFW hail report(s)" % (day_str, len(events)))
        for e in events:
            print("  %s  %s, %s Co  size=%s in  zips=%d" % (
                e["event_time"], e["location"], e["county"],
                e["size_in"], len(e["affected"])))
        if args.commit:
            upsert_events(env, events)
            print("  committed %d row(s) (upsert on source_key)" % len(events))
        else:
            print("  DRY RUN (use --commit to write)")
        total += len(events)
        if args.stop_first and total:
            break
    print("Done. %d DFW event(s) found." % total)


if __name__ == "__main__":
    main()
