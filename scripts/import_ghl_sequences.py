"""import_ghl_sequences.py - rescue the GHL-era email sequences into the OS.

GoHighLevel is retired (2026-08-22, API dead), but every sequence Wing sent
through it survives as local files in ghl-cli. This pulls them into the
sequences engine as DRAFTS:

  - Jackson Roofing D1/D3/D7   from clients/templates/jackson.json
  - Wing Pest Control D1/D3/D7 from templates/wing-pest-sequence.md
  - Wing Plumbing D1/D3/D7     from templates/wing-plumbing-sequence.md

(Wing B2B D1/D3/D7 is not imported here; it was already seeded into the
engine on 2026-09-01 as "Wing B2B Cold Outreach".)

Merge tags convert to the engine's vocabulary: {first} -> {{first_name}},
{company} -> {{company}}. Everything lands status='draft'; nothing sends.
Idempotent: a sequence whose name already exists is skipped.

Run:  python scripts/import_ghl_sequences.py           (dry run)
      python scripts/import_ghl_sequences.py --commit
"""
import json, os, re, sys, urllib.request, urllib.error

GHL = r"C:\Users\wjack\ghl-cli"
ENV_PATH = os.path.join(GHL, ".env")
COMMIT = "--commit" in sys.argv


def load_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env(ENV_PATH)
URL, KEY = ENV["OS_SUPABASE_URL"], ENV["OS_SUPABASE_SERVICE_KEY"]


def rest(path, data=None, method=None):
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}",
               "Content-Type": "application/json", "Prefer": "return=representation"}
    req = urllib.request.Request(f"{URL}/rest/v1/{path}",
                                 data=json.dumps(data).encode() if data is not None else None,
                                 headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read().decode()
        return json.loads(body) if body else []


def tags(text):
    """GHL-era merge points -> engine merge tags."""
    return (text.replace("{first}", "{{first_name}}")
                .replace("{company}", "{{company}}")
                .replace("{{contact.first_name}}", "{{first_name}}")
                .replace("{{contact.company_name}}", "{{company}}"))


def parse_sequence_md(path):
    """The pest/plumbing masters: '## Day N' sections with a **Subject:** line."""
    text = open(path, encoding="utf-8").read()
    steps = []
    for m in re.finditer(r"##\s*Day\s*(\d+)\s*\n(.*?)(?=\n##\s*Day|\Z)", text, re.S):
        day, block = int(m.group(1)), m.group(2)
        subj = re.search(r"\*\*Subject:?\*\*\s*`?([^`\n]+)`?", block)
        # Body = everything after the subject line, stripped of md artifacts.
        body = block[subj.end():] if subj else block
        body = re.sub(r"^\s*-+\s*$", "", body, flags=re.M).strip()
        steps.append({"day": day, "subject": tags(subj.group(1).strip()) if subj else None,
                      "body": tags(body)})
    return steps


def jackson_steps():
    d = json.load(open(os.path.join(GHL, "clients", "templates", "jackson.json"), encoding="utf-8"))
    subs, bodies = d["subjects"], d["bodies"]
    out = []
    for day in (1, 3, 7):
        s, b = subs.get(f"s{day}"), bodies.get(f"d{day}")
        if not b:
            print(f"  jackson: no body for day {day}, skipping that step")
            continue
        out.append({"day": day, "subject": tags(s) if s else None, "body": tags(b)})
    return out


SEQUENCES = [
    ("Jackson Roofing D1/D3/D7", "jackson",
     "Rescued from the GHL-era Jackson sequence (clients/templates/jackson.json). Chris Jackson's voice.",
     jackson_steps),
    ("Wing Pest Control Cold Outreach", None,
     "Rescued from templates/wing-pest-sequence.md. Independent operators only, never franchise branches.",
     lambda: parse_sequence_md(os.path.join(GHL, "templates", "wing-pest-sequence.md"))),
    ("Wing Plumbing Cold Outreach", None,
     "Rescued from templates/wing-plumbing-sequence.md.",
     lambda: parse_sequence_md(os.path.join(GHL, "templates", "wing-plumbing-sequence.md"))),
]


def main():
    existing = {s["name"] for s in rest("sequences?select=name")}
    for name, client, desc, loader in SEQUENCES:
        if name in existing:
            print(f"SKIP (exists): {name}")
            continue
        steps = loader()
        if not steps:
            print(f"SKIP (no steps parsed): {name}")
            continue
        days = [s["day"] for s in steps]
        print(f"{'IMPORT' if COMMIT else 'DRY'}: {name} - {len(steps)} steps (days {days})")
        for s in steps:
            print(f"    day {s['day']}: subject={s['subject']!r}, body {len(s['body'])} chars")
        if not COMMIT:
            continue
        seq = rest("sequences", {"name": name, "client_slug": client, "status": "draft",
                                 "description": desc}, "POST")[0]
        prev_day = 0
        for order, s in enumerate(sorted(steps, key=lambda x: x["day"]), start=1):
            rest("sequence_steps", {
                "sequence_id": seq["id"], "step_order": order,
                # wait_days is relative to the PREVIOUS step (engine contract).
                "wait_days": s["day"] - prev_day if order > 1 else 0,
                "channel": "email", "subject": s["subject"], "body": s["body"],
            }, "POST")
            prev_day = s["day"]
        print(f"    committed sequence {seq['id']}")
    if not COMMIT:
        print("\nDRY RUN. Nothing was written. Re-run with --commit.")


if __name__ == "__main__":
    main()
