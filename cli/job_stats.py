#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError


ENV_DEFAULT = Path("worker/.env.prod")
PERCENT_WIDTH = 60
DURATION_RE = re.compile(r"Duration:\s*(?:(?P<minutes>\d+)m\s*)?(?P<seconds>[\d.]+)s", re.IGNORECASE)


def load_env_file(path: Path) -> Dict[str, str]:
    if not path.exists():
        raise SystemExit(f"env file not found: {path}")
    data: Dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip()
    return data


def resolve_api_url(env: Dict[str, str]) -> str:
    if env.get("API_URL"):
        return env["API_URL"].rstrip("/")
    supabase = env.get("SUPABASE_URL")
    if not supabase:
        raise SystemExit("API_URL or SUPABASE_URL is required.")
    base = supabase.rstrip("/")
    if base.endswith("/functions/v1/api"):
        return base
    return f"{base}/functions/v1/api"


def resolve_api_key(env: Dict[str, str]) -> Optional[str]:
    return env.get("API_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_ANON_KEY")


def fetch_json(url: str, headers: Dict[str, str]) -> Any:
    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except URLError as exc:
        raise SystemExit(f"failed to fetch {url}: {exc}")


def parse_iso8601(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        normalized = value.strip()
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def parse_duration_from_logs(logs: Optional[str]) -> Optional[float]:
    if not logs:
        return None
    match = DURATION_RE.search(logs)
    if not match:
        return None
    minutes = int(match.group("minutes") or 0)
    seconds = float(match.group("seconds") or 0)
    return minutes * 60 + seconds


def task_duration(task: Dict[str, Any]) -> Optional[float]:
    start = parse_iso8601(task.get("startedAt"))
    end = parse_iso8601(task.get("endedAt"))
    if start and end:
        return max(0.0, (end - start).total_seconds())
    return parse_duration_from_logs(task.get("logs"))


def job_timings(build: Dict[str, Any]) -> Optional[Dict[str, datetime]]:
    started = parse_iso8601(build.get("started_at"))
    ended = parse_iso8601(build.get("ended_at"))
    metadata = build.get("metadata") or {}
    timings = metadata.get("timings") if isinstance(metadata, dict) else None
    total = timings.get("total") if isinstance(timings, dict) else None
    if not started and total:
        started = parse_iso8601(total.get("started_at"))
    if not ended and total:
        ended = parse_iso8601(total.get("ended_at"))
    if started and ended:
        return {"started": started, "ended": ended}
    return None


def summarize_phase_stats(phase_durations: Dict[str, List[float]]) -> List[str]:
    lines: List[str] = []
    header = f"{'phase':<30} {'count':>5} {'avg(s)':>8} {'min(s)':>8} {'max(s)':>8}"
    lines.append(header)
    lines.append("-" * len(header))
    for phase in sorted(phase_durations):
        durations = phase_durations[phase]
        if not durations:
            continue
        avg = sum(durations) / len(durations)
        minimum = min(durations)
        maximum = max(durations)
        lines.append(f"{phase:<30} {len(durations):5} {avg:8.2f} {minimum:8.2f} {maximum:8.2f}")
    return lines


def render_timeline(entries: List[Dict[str, Any]]) -> List[str]:
    if not entries:
        return ["no timeline data available"]
    starts = [entry["timings"]["started"] for entry in entries]
    ends = [entry["timings"]["ended"] for entry in entries]
    earliest = min(starts)
    latest = max(ends)
    span = (latest - earliest).total_seconds()
    if span <= 0:
        span = 1
    lines = ["timeline (each '#' ≈ {:.1f}s)".format(span / PERCENT_WIDTH)]
    for entry in entries:
        job_id = entry["job_id"]
        start = entry["timings"]["started"]
        end = entry["timings"]["ended"]
        start_offset = int(((start - earliest).total_seconds() / span) * PERCENT_WIDTH)
        end_offset = int(((end - earliest).total_seconds() / span) * PERCENT_WIDTH)
        if end_offset <= start_offset:
            end_offset = start_offset + 1
        bar = [" "] * PERCENT_WIDTH
        for idx in range(start_offset, min(end_offset, PERCENT_WIDTH)):
            bar[idx] = "#"
        line = "".join(bar)
        lines.append(f"{job_id[:12]:12} |{line}| {start.strftime('%H:%M:%S')}->{end.strftime('%H:%M:%S')}")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze job timings from the worker queue.")
    parser.add_argument(
        "--env-file",
        type=Path,
        default=ENV_DEFAULT,
        help="Env file with SUPABASE_URL and keys.",
    )
    args = parser.parse_args()

    env = load_env_file(args.env_file)
    api_url = resolve_api_url(env)
    api_key = resolve_api_key(env)
    if not api_key:
        raise SystemExit("API key missing from env.")
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}

    jobs_payload = fetch_json(f"{api_url}/worker/jobs", headers)
    jobs = jobs_payload.get("jobs", [])
    succeeded = [job for job in jobs if job.get("status") == "succeeded"]
    if not succeeded:
        print("No succeeded jobs found.")
        return 0

    phase_durations: Dict[str, List[float]] = defaultdict(list)
    timeline_entries: List[Dict[str, Any]] = []
    durations_overall: List[float] = []

    for job in sorted(succeeded, key=lambda j: j.get("created_at") or ""):
        job_id = job.get("job_id")
        if not job_id:
            continue
        build = fetch_json(f"{api_url}/builds?jobId={job_id}", headers)
        if not isinstance(build, dict):
            continue
        metadata = build.get("metadata") or {}
        tasks = build.get("tasks") or []
        for task in tasks:
            duration = task_duration(task)
            if duration is not None:
                phase_durations[task.get("name") or "unnamed"].append(duration)
        timings = job_timings(build)
        if timings:
            timeline_entries.append({"job_id": job_id, "timings": timings})
            durations_overall.append((timings["ended"] - timings["started"]).total_seconds())

    print("\nPhase duration stats (s) over succeeded jobs:")
    for line in summarize_phase_stats(phase_durations):
        print(line)

    if durations_overall:
        avg_total = sum(durations_overall) / len(durations_overall)
        min_total = min(durations_overall)
        max_total = max(durations_overall)
        print(f"\nJob totals: count={len(durations_overall)} avg={avg_total:.1f}s min={min_total:.1f}s max={max_total:.1f}s")

    print("\nJob timeline (start -> end):")
    for line in render_timeline(timeline_entries):
        print(line)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
