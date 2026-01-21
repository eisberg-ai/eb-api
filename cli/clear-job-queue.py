#!/usr/bin/env python3
"""
Clear the worker job queue by deleting jobs in Supabase.

It will try to load credentials from the environment first and, if missing,
auto-source ../api/supabase/.env relative to this script.

Required values (unless overridden via CLI flags):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Usage examples:
  python scripts/clear_job_queue.py
  python scripts/clear_job_queue.py --env supabase        # force local 127.0.0.1:54321
  python scripts/clear_job_queue.py --url https://...     # custom URL
  python scripts/clear_job_queue.py --include-terminal    # also delete succeeded jobs
"""

import json
import os
import sys
from pathlib import Path
from urllib import request, error
import argparse


STATUSES_TO_CLEAR = ["queued", "claimed", "running"]
TERMINAL_STATUSES = ["succeeded"]
ENV_FALLBACK_PATH = Path(__file__).resolve().parent.parent / "api" / "supabase" / ".env"
LOCAL_SUPABASE_URL = "http://127.0.0.1:54321"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


def get_config(args: argparse.Namespace):
    # Load from env first; if missing, try the local .env
    if not (os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY")):
        load_env_file(ENV_FALLBACK_PATH)

    # Resolve URL
    supabase_url = args.url
    if not supabase_url:
        if args.env and args.env.lower() == "supabase":
            supabase_url = LOCAL_SUPABASE_URL
        else:
            supabase_url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")

    service_key = args.service_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not service_key:
        raise SystemExit("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (even after loading .env).")

    return supabase_url.rstrip("/"), service_key


def clear_queue(args: argparse.Namespace):
    supabase_url, service_key = get_config(args)
    statuses = STATUSES_TO_CLEAR.copy()
    if args.include_terminal:
        statuses += TERMINAL_STATUSES
    endpoint = f"{supabase_url}/rest/v1/jobs?status=in.({','.join(statuses)})"

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
        "Accept": "application/json",
    }

    req = request.Request(endpoint, method="DELETE", headers=headers)

    try:
        with request.urlopen(req) as resp:
            body = resp.read()
            deleted_count = 0
            if body:
                try:
                    data = json.loads(body)
                    if isinstance(data, list):
                        deleted_count = len(data)
                except json.JSONDecodeError:
                    pass
            print(f"Cleared {deleted_count} job(s) with status {', '.join(statuses)}.")
    except error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")
        raise SystemExit(f"Failed to clear queue ({e.code}): {detail}")
    except Exception as e:
        raise SystemExit(f"Failed to clear queue: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Clear the worker job queue (Supabase).")
    parser.add_argument("--env", choices=["supabase"], help="Preset: 'supabase' uses local 127.0.0.1:54321.")
    parser.add_argument("--url", help="Override Supabase URL (e.g. https://xyz.supabase.co)")
    parser.add_argument("--service-key", dest="service_key", help="Override Supabase service role key")
    parser.add_argument(
        "--include-terminal",
        action="store_true",
        help="Also delete jobs that already succeeded.",
    )
    args = parser.parse_args()
    clear_queue(args)
