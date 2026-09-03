"""
apply_migration.py -- run one SQL migration file against the OS Supabase project.

Uses the Supabase Management API (POST /v1/projects/{ref}/database/query), the
same path tools/send_safety_check.py already uses for read-only introspection.
Unlike that script this one WRITES: it executes the migration's DDL exactly as
written. Every migration in supabase/migrations/ is idempotent (create table if
not exists / drop policy if exists), so re-running one is safe.

Reads (names only, values never printed):
  ghl-cli/.env  -> SUPABASE_ACCESS_TOKEN, OS_SUPABASE_REF

USAGE
  python tools/apply_migration.py supabase/migrations/0021_automations.sql
  python tools/apply_migration.py --check          # connectivity: runs select 1
  python tools/apply_migration.py --sql "select count(*) from public.workflows"
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
GHL_ENV_PATH = ROOT.parent / "ghl-cli" / ".env"


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def run_sql(sql: str) -> list[dict]:
    env = load_env(GHL_ENV_PATH)
    token = env.get("SUPABASE_ACCESS_TOKEN")
    ref = env.get("OS_SUPABASE_REF")
    if not token or not ref:
        sys.exit("SUPABASE_ACCESS_TOKEN / OS_SUPABASE_REF missing from ghl-cli/.env")
    r = requests.post(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"query": sql},
        timeout=120,
    )
    if r.status_code >= 300:
        sys.exit(f"Management API {r.status_code}: {r.text[:800]}")
    try:
        return r.json()
    except ValueError:
        return []


def main(argv: list[str]) -> None:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    if argv[0] == "--check":
        print(run_sql("select 1 as ok"))
        return
    if argv[0] == "--sql":
        print(json.dumps(run_sql(" ".join(argv[1:])), indent=2, default=str))
        return
    path = Path(argv[0])
    if not path.is_absolute():
        path = ROOT / path
    if not path.exists():
        sys.exit(f"no such file: {path}")
    sql = path.read_text(encoding="utf-8")
    print(f"applying {path.name} ({len(sql)} chars) ...")
    out = run_sql(sql)
    print("ok", out if out else "")


if __name__ == "__main__":
    main(sys.argv[1:])
