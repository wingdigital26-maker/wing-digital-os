"""storm_drafts.py - generate DRAFT storm-response copy for storm_events rows.

For every storm_event with no drafts yet, writes three storm_drafts rows
(client_slug null = generic demo copy): fb_post, ad_spec, nextdoor.
All rows land with status 'draft'.

DEMO-ONLY HARD RULE: this script produces database rows, full stop.
It never posts to any platform, never creates or touches any ad account,
never calls any Meta/Nextdoor/social API, and never spends anything.
The ad_spec is a document a human COULD hand-enter into Meta, not an
API payload, and no approval/publish lane exists in this build.

Copy is pure Python templating over real event fields. Nothing is
fabricated: missing fields (size, county, location) are simply omitted
from the copy. No phone numbers ever (Contact Us framing only, per
Jack's site rules). No em dashes anywhere.

Usage:
  python storm_drafts.py            # dry run: show what would be drafted
  python storm_drafts.py --commit   # insert the draft rows
"""

import argparse
import json
import sys
from datetime import datetime

from storm_watch import load_env, supabase_request

LANDING = "https://wing-digital-os.vercel.app/book"


def fmt_size(size_in):
    if size_in is None:
        return None
    s = float(size_in)
    return ("%g" % s) + " inch"


def event_city(event):
    aff = event.get("affected") or []
    if aff:
        return aff[0]["city"]
    loc = event.get("location")
    if loc:
        return loc.title()
    return None


def nice_date(iso):
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%B %d")
    except (ValueError, AttributeError):
        return None


def build_fb_post(event):
    city = event_city(event)
    county = event.get("county")
    size = fmt_size(event.get("size_in"))
    date = nice_date(event.get("event_time", ""))

    area = city or (county + " County" if county else "your area")
    lines = []
    opener = "Hail came through " + area
    if date:
        opener += " on " + date
    opener += "."
    lines.append(opener)
    if size:
        lines.append("Reports show hail around " + size + " in diameter. That is big enough to bruise shingles even when everything looks fine from the ground.")
    else:
        lines.append("Even smaller hail can bruise shingles in ways you cannot see from the ground.")
    lines.append("If your neighborhood got hit, it is worth having the roof looked at before the next storm finds the weak spots.")
    lines.append("We are offering free roof inspections for homeowners in " + area + ". No pressure, no obligation. We check it, we show you photos, and you decide what to do next.")
    lines.append("Tap Contact Us and we will get you on the schedule.")
    return {"text": "\n\n".join(lines)}


def build_ad_spec(event):
    city = event_city(event)
    county = event.get("county")
    size = fmt_size(event.get("size_in"))
    date = nice_date(event.get("event_time", ""))

    area = city or (county + " County" if county else "the DFW area")
    headline = ("Hail Hit " + area + "? Free Roof Inspection") if city or county else "Hail Damage? Free Roof Inspection"
    primary_bits = []
    s = "Hail was reported in " + area
    if date:
        s += " on " + date
    primary_bits.append(s + ".")
    if size:
        primary_bits.append("Stones around " + size + " can damage shingles without leaving obvious signs.")
    primary_bits.append("Get a free, no obligation roof inspection with photo documentation. Local crew, honest answers, and you decide what happens next.")
    return {
        "headline": headline,
        "primary_text": " ".join(primary_bits),
        "description": "Free inspection. Photo report. No pressure.",
        "geo_zips": [z["zip"] for z in (event.get("affected") or [])],
        "radius_mi": 8,
        "daily_budget_usd": 75,
        "duration_days": 3,
        "cta": "Book Now",
        "landing": LANDING,
        "status_note": "DRAFT. No ad account is touched. Approval flow not built yet.",
    }


def build_nextdoor(event):
    city = event_city(event)
    county = event.get("county")
    size = fmt_size(event.get("size_in"))
    date = nice_date(event.get("event_time", ""))

    area = city or (county + " County" if county else "our area")
    lines = []
    opener = "Neighbors, checking in after the hail that moved through " + area
    if date:
        opener += " on " + date
    opener += "."
    lines.append(opener)
    if size:
        lines.append("The reports we saw showed hail close to " + size + ". At that size it can bruise a roof without anything looking wrong from the street, and small damage tends to turn into leaks months later.")
    else:
        lines.append("Hail can bruise a roof without anything looking wrong from the street, and small damage tends to turn into leaks months later.")
    lines.append("If you are in the " + area + " area and want a second set of eyes on your roof, we do free inspections with photos so you can see exactly what is up there. No sales pitch, just an honest look.")
    lines.append("Feel free to reach out through our Contact Us page if that would be helpful.")
    return {"text": "\n\n".join(lines)}


BUILDERS = {"fb_post": build_fb_post, "ad_spec": build_ad_spec, "nextdoor": build_nextdoor}


def main():
    ap = argparse.ArgumentParser(description="Generate draft storm copy (demo-only)")
    ap.add_argument("--commit", action="store_true", help="insert rows (default dry run)")
    args = ap.parse_args()

    env = load_env()
    events = supabase_request(env, "storm_events?select=id,event_time,size_in,location,county,affected&order=event_time.desc")
    existing = supabase_request(env, "storm_drafts?select=event_id")
    drafted = {d["event_id"] for d in (existing or [])}

    new_rows = []
    for ev in events or []:
        if ev["id"] in drafted:
            continue
        for kind, builder in BUILDERS.items():
            new_rows.append({
                "event_id": ev["id"],
                "kind": kind,
                "client_slug": None,
                "content": builder(ev),
                "status": "draft",
            })

    print("%d event(s), %d already drafted, %d new draft row(s)" % (
        len(events or []), len(drafted), len(new_rows)))
    if not new_rows:
        return
    if args.commit:
        supabase_request(env, "storm_drafts", method="POST", body=new_rows,
                         extra_headers={"Prefer": "return=minimal"})
        print("Committed %d draft row(s), all status=draft." % len(new_rows))
    else:
        print("DRY RUN. Sample:")
        print(json.dumps(new_rows[0], indent=2))


if __name__ == "__main__":
    sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
    main()
