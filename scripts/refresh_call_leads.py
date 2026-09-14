#!/usr/bin/env python3
"""
One-pass refresh for the cold-call room, safe to run on a schedule.

Keeps the call sheet from running dry and keeps names improving as enrichment
lands, in a single idempotent command:

  1. import_call_leads.py  -- top up call_leads with serviceable prospects
  2. backfill_call_names.py -- fill any NULL contact_name that now has a real
                               person's name in prospects.db

Both steps are idempotent and never touch call working state (status, claims,
call counts). Dry run by default; pass --commit to actually write. Designed for
a hidden scheduled task -- it prints a compact summary and exits non-zero only
if a step fails, so a watchdog can alert on a real failure.

Usage:
    python scripts/refresh_call_leads.py             # dry run both steps
    python scripts/refresh_call_leads.py --commit     # write both
    python scripts/refresh_call_leads.py --commit --source apollo-2026-09-13
"""
import argparse
import subprocess
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


def run(script: str, extra: list[str]) -> int:
    cmd = [PY, os.path.join(HERE, script), *extra]
    print(f"\n=== {script} {' '.join(extra)} ===", flush=True)
    return subprocess.call(cmd)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="actually write to Supabase")
    ap.add_argument("--source", help="pass through to import_call_leads.py")
    args = ap.parse_args()

    flags = ["--commit"] if args.commit else []

    import_flags = list(flags)
    if args.source:
        import_flags += ["--source", args.source]

    rc_import = run("import_call_leads.py", import_flags)
    if rc_import != 0:
        print("\nrefresh: import step FAILED, skipping name backfill.", file=sys.stderr)
        return rc_import

    rc_backfill = run("backfill_call_names.py", list(flags))
    if rc_backfill != 0:
        print("\nrefresh: name backfill step FAILED.", file=sys.stderr)
        return rc_backfill

    mode = "committed" if args.commit else "dry run (nothing written)"
    print(f"\nrefresh complete -- {mode}. Import + name backfill both clean.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
