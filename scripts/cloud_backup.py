#!/usr/bin/env python3
"""cloud_backup.py -- PC-OFF backup of the Wing OS.

The local os_backup.py (ghl-cli) does the same job but reads the Obsidian vault
off Jack's C: drive, so it only ever runs while the PC is awake. A backup that
only runs when the machine is awake is the one that is missing on the day the
machine does not come back. This version sources the vault from the private
GitHub mirror instead, so it runs on a GitHub Actions runner on a schedule that
does not care whether any PC is on.

What it does, in order:
  1. Verify the vault mirror it was handed is real and FRESH. The mirror is
     pushed from the PC (WingVaultSync), so a long PC outage means the mirror
     is stale. Backing up a stale mirror is fine; PRETENDING it is current is
     not. Staleness is measured from the mirror's own last commit and reported.
  2. Upsert every vault markdown page into Supabase vault_docs.
  3. Export every OS table to JSON in an output directory (uploaded as a
     workflow artifact by the caller).
  4. Write MANIFEST.json with real row counts, real failures, and mirror age.
  5. Report a heartbeat (ok / error) so the cloud watchdog can push Jack's phone.

HARD RULE inherited from the incident history: this exits non-zero and says
exactly what is missing whenever any part of it could not be proven. It never
writes an empty file in place of a table it failed to read, because a partial
backup that reports success is the one you discover while restoring.

Env (all required unless noted):
  OS_SUPABASE_URL          OS project REST url   (NOT the Sonar project)
  OS_SUPABASE_SERVICE_KEY  OS project service key
  VAULT_DIR                path to the checked-out vault mirror
  BACKUP_OUT               output dir for the export      (default ./backup-out)
  VAULT_MAX_AGE_HOURS      mirror staleness limit         (default 72)
  VAULT_MIN_DOCS           refuse a suspiciously tiny vault (default 50)
  HEARTBEAT_URL            heartbeat endpoint             (optional)
  HEARTBEAT_KEY            heartbeat shared key           (optional)
  SKIP_VAULT=1             export tables only
"""
import datetime
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

TABLES = [
    "clients", "profiles", "client_users", "agent_runs",
    "health_scores", "deliverables", "vault_docs",
]

# Mirrors the ignore list the app uses. `raw` is never read and never written.
SKIP_DIRS = {".obsidian", ".git", ".claude", ".trash", "node_modules", "raw"}
MAX_DOC_BYTES = 500_000
BATCH = 100


def env(name, default=None, required=False):
    v = os.environ.get(name, default)
    if required and not v:
        die(f"missing required env var {name}")
    return v


PROBLEMS = []


def die(msg):
    """Stop now and say what is missing. Used only for setup faults."""
    print(f"FATAL: {msg}", flush=True)
    heartbeat("error", f"backup could not start: {msg}")
    sys.exit(2)


def heartbeat(status, message, files_changed=None):
    url = os.environ.get("HEARTBEAT_URL")
    key = os.environ.get("HEARTBEAT_KEY")
    if not url or not key:
        print(f"[heartbeat skipped: not configured] {status}: {message}")
        return
    payload = {
        "agent": os.environ.get("HEARTBEAT_AGENT", "os-backup-cloud"),
        "status": status,
        "message": message[:500],
    }
    # Optional: how many files this run wrote. Shows as "N files updated" on
    # the OS Agents tab. Only sent when known — never a fabricated 0.
    if isinstance(files_changed, int) and files_changed >= 0:
        payload["files_changed"] = files_changed
    try:
        r = requests.post(
            url,
            headers={"x-heartbeat-key": key, "Content-Type": "application/json"},
            data=json.dumps(payload),
            timeout=30,
        )
        print(f"[heartbeat {status}] -> HTTP {r.status_code}")
    except requests.exceptions.RequestException as e:
        # A heartbeat we could not send is itself worth printing: it means the
        # phone alert for this run did not happen.
        print(f"[heartbeat FAILED to send] {type(e).__name__}: {str(e)[:120]}")


def req(method, url, **kw):
    """One HTTP call, retried through a dropped connection. Returns None when
    every attempt failed, so the caller decides what that means rather than
    dying where it stands."""
    kw.setdefault("timeout", 90)
    delay = 5
    for attempt in range(4):
        try:
            return getattr(requests, method)(url, **kw)
        except requests.exceptions.RequestException as e:
            if attempt == 3:
                print(f"  network gave up after 4 tries: {type(e).__name__}: {str(e)[:120]}")
                return None
            time.sleep(delay)
            delay *= 2


# ── 1. mirror freshness ──────────────────────────────────────────────────────
def mirror_age_hours(vault: Path):
    """Hours since the vault mirror's last commit, or None if unknowable.

    None is NOT treated as fresh. An age we cannot measure is reported as
    CANTCHECK and fails the run, because silence must never mean success.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(vault), "log", "-1", "--format=%cI"],
            capture_output=True, text=True, timeout=60,
        )
        if out.returncode != 0 or not out.stdout.strip():
            return None, None
        ts = datetime.datetime.fromisoformat(out.stdout.strip())
        now = datetime.datetime.now(datetime.timezone.utc)
        return (now - ts).total_seconds() / 3600.0, ts.isoformat()
    except Exception as e:
        print(f"  could not read mirror commit date: {type(e).__name__}: {e}")
        return None, None


# ── 2. vault -> vault_docs ───────────────────────────────────────────────────
def collect_docs(vault: Path):
    docs = []
    skipped_big = 0
    for f in vault.rglob("*.md"):
        rel_parts = f.relative_to(vault).parts
        if any(p in SKIP_DIRS or p.startswith(".") for p in rel_parts[:-1]):
            continue
        try:
            txt = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if len(txt.encode("utf-8")) > MAX_DOC_BYTES:
            skipped_big += 1
            continue
        rel = "/".join(rel_parts)
        title = f.stem
        for line in txt.splitlines():
            if line.strip().startswith("# "):
                title = line.strip("# ").strip()
                break
        docs.append({
            "path": rel, "title": title[:300],
            "folder": rel_parts[0] if len(rel_parts) > 1 else "root",
            "content": txt, "bytes": len(txt.encode("utf-8")),
        })
    if skipped_big:
        print(f"  {skipped_big} page(s) over {MAX_DOC_BYTES} bytes were skipped by design")
    return docs


def sync_vault(url, svc, vault: Path, min_docs: int):
    docs = collect_docs(vault)
    print(f"vault mirror: {len(docs)} markdown pages found at {vault}")
    if len(docs) < min_docs:
        # A checkout that produced almost nothing is a broken checkout (wrong
        # branch, empty clone, bad path), not a small vault. Upserting it would
        # be harmless but reporting it as a backup would be a lie.
        PROBLEMS.append(
            f"vault mirror has only {len(docs)} pages (expected at least {min_docs}) "
            f"- treating this as a BROKEN CHECKOUT, not a small vault")
        return 0, len(docs)

    headers = {
        "apikey": svc, "Authorization": f"Bearer {svc}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    ok = 0
    for i in range(0, len(docs), BATCH):
        chunk = docs[i:i + BATCH]
        r = req("post", f"{url}/rest/v1/vault_docs?on_conflict=path",
                headers=headers, data=json.dumps(chunk))
        if r is None:
            PROBLEMS.append(f"vault_docs upsert: network gave up at page {i}")
            break
        if r.status_code < 300:
            ok += len(chunk)
        else:
            PROBLEMS.append(f"vault_docs upsert HTTP {r.status_code}: {r.text[:200]}")
            break
    print(f"vault sync: {ok}/{len(docs)} pages upserted into vault_docs")
    if ok < len(docs):
        PROBLEMS.append(f"vault sync INCOMPLETE: {ok}/{len(docs)} pages")
    return ok, len(docs)


# ── 3. tables -> json export ─────────────────────────────────────────────────
def export_tables(url, svc, outdir: Path):
    summary, failed = {}, []
    headers = {"apikey": svc, "Authorization": f"Bearer {svc}"}
    for t in TABLES:
        rows, off = [], 0
        broke = False
        while True:
            r = req("get", f"{url}/rest/v1/{t}?select=*&limit=1000&offset={off}",
                    headers=headers)
            if r is None:
                failed.append(f"{t} (network)")
                broke = True
                break
            if r.status_code >= 300:
                # The old script `break`d here and wrote whatever it had, so a
                # 401 on page 3 produced a truncated file that looked complete.
                failed.append(f"{t} (HTTP {r.status_code}: {r.text[:120]})")
                broke = True
                break
            body = r.json()
            rows += body
            if len(body) < 1000:
                break
            off += 1000
        if broke:
            continue
        (outdir / f"{t}.json").write_text(
            json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        summary[t] = len(rows)
    return summary, failed


def main():
    url = env("OS_SUPABASE_URL", required=True).rstrip("/")
    svc = env("OS_SUPABASE_SERVICE_KEY", required=True)
    outdir = Path(env("BACKUP_OUT", "backup-out"))
    outdir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%SZ")

    # Guard against the classic footgun: the OS project and the Sonar project
    # are different Supabase projects and their keys are interchangeable-looking.
    print(f"OS Supabase host: {url.split('//')[-1].split('.')[0]}")

    vault_age, vault_commit = None, None
    docs_ok = docs_total = 0
    max_age = float(env("VAULT_MAX_AGE_HOURS", "72"))
    # A tables-only run is a legitimate thing to ask for, but it must never be
    # filed away looking like a full backup. The manifest and the heartbeat both
    # carry the words NO VAULT so that the copy you reach for during a restore
    # tells you what it is not.
    skip_vault = env("SKIP_VAULT") == "1"

    if not skip_vault:
        vault = Path(env("VAULT_DIR", required=True))
        if not vault.is_dir():
            die(f"VAULT_DIR does not exist: {vault}")
        vault_age, vault_commit = mirror_age_hours(vault)
        if vault_age is None:
            PROBLEMS.append(
                "CANTCHECK: could not read the vault mirror's last commit date, "
                "so its freshness is unknown. Not assuming it is current.")
        else:
            print(f"vault mirror last commit: {vault_commit} ({vault_age:.1f}h ago)")
            if vault_age > max_age:
                PROBLEMS.append(
                    f"vault mirror is STALE: last pushed {vault_age:.1f}h ago "
                    f"(limit {max_age:.0f}h). The mirror is pushed from Jack's PC "
                    f"(WingVaultSync), so this usually means the PC has been off or "
                    f"that task is broken. The data below is a backup of a "
                    f"{vault_age / 24:.1f}-day-old vault.")
        docs_ok, docs_total = sync_vault(url, svc, vault, int(env("VAULT_MIN_DOCS", "50")))

    summary, failed = export_tables(url, svc, outdir)
    for f in failed:
        PROBLEMS.append(f"table unreadable: {f}")
    if not summary:
        PROBLEMS.append("EMPTY BACKUP - not one table was exported")

    manifest = {
        "created_utc": stamp,
        "source": "github-actions (PC-off)",
        "supabase_host": url.split("//")[-1].split(".")[0],
        "vault_mirror_commit": vault_commit,
        "vault_mirror_age_hours": None if vault_age is None else round(vault_age, 2),
        "vault_pages_upserted": docs_ok,
        "vault_pages_found": docs_total,
        "tables": summary,
        "failed_tables": failed,
        "vault_included": not skip_vault,
        "problems": PROBLEMS,
        "status": ("FAILED" if PROBLEMS
                   else "PARTIAL - TABLES ONLY, NO VAULT" if skip_vault
                   else "ok"),
    }
    (outdir / "MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("\n=== BACKUP RESULT ===")
    print("tables: " + (", ".join(f"{t}={n}" for t, n in summary.items()) or "(none)"))
    print(f"vault:  {docs_ok}/{docs_total} pages")
    if PROBLEMS:
        print("\nBACKUP FAILED. Problems:")
        for p in PROBLEMS:
            print(f"  - {p}")
        heartbeat("error", "OS cloud backup FAILED: " + "; ".join(PROBLEMS))
        return 1
    tbl = ", ".join(f"{t}={n}" for t, n in summary.items())
    if skip_vault:
        print("\nPARTIAL BACKUP - TABLES ONLY, NO VAULT IN THIS ARCHIVE.")
        heartbeat("ok", f"OS cloud backup PARTIAL - TABLES ONLY, NO VAULT: {tbl}",
                  files_changed=len(summary))
        return 0
    print("\nbackup complete and verified.")
    heartbeat("ok", f"OS cloud backup ok: {docs_ok} vault pages, {tbl}",
              files_changed=docs_ok + len(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
