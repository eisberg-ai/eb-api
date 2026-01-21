#!/usr/bin/env python3
"""
Summarize Sonic/SonicMin telemetry JSONL into a readable report.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _load_events(path: Path) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = ev.get("ts")
        if not ts:
            continue
        ev["_ts"] = _parse_ts(ts)
        events.append(ev)
    events.sort(key=lambda r: r["_ts"])
    return events


def _find_latest_log(log_dir: Path) -> Optional[Path]:
    if not log_dir.exists():
        return None
    candidates = [
        path
        for path in log_dir.glob("*.jsonl")
        if path.name.startswith("sonic") and "trace" not in path.name
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _first_event_ts(events: List[Dict[str, Any]], predicate) -> Optional[datetime]:
    for ev in events:
        if predicate(ev):
            return ev["_ts"]
    return None


def _extract_tool_counts(events: List[Dict[str, Any]]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for ev in events:
        if ev.get("event_type") == "tool_start":
            payload = ev.get("payload") or {}
            if isinstance(payload, dict):
                name = payload.get("tool")
                if name:
                    counts[str(name)] += 1
    if counts:
        return counts
    for ev in events:
        if ev.get("event_type") != "llm_message":
            continue
        payload = ev.get("payload") or {}
        blocks = payload.get("blocks") if isinstance(payload, dict) else None
        if not isinstance(blocks, dict):
            continue
        for tu in blocks.get("tool_use", []) or []:
            if not isinstance(tu, dict):
                continue
            name = tu.get("name")
            if name:
                counts[str(name)] += 1
    return counts


def _extract_read_paths(events: List[Dict[str, Any]]) -> List[str]:
    paths: List[str] = []
    for ev in events:
        if ev.get("event_type") != "tool_start":
            continue
        payload = ev.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        if payload.get("tool") != "Read":
            continue
        input_payload = payload.get("input") or {}
        if not isinstance(input_payload, dict):
            continue
        preview = input_payload.get("preview") or {}
        if isinstance(preview, dict) and preview.get("file_path"):
            paths.append(preview["file_path"])
    # de-dup, preserve order
    seen = set()
    unique = []
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        unique.append(path)
    return unique


def _format_duration(seconds: Optional[float]) -> str:
    if seconds is None:
        return "-"
    return f"{seconds:.1f}s"


def _render_report(path: Path, events: List[Dict[str, Any]]) -> str:
    if not events:
        return f"No events found in {path}"

    start_ts = events[0]["_ts"]
    end_ts = events[-1]["_ts"]
    duration = (end_ts - start_ts).total_seconds()

    first_prompt = _first_event_ts(events, lambda ev: ev.get("event_type") == "prompt_submit")
    first_task = _first_event_ts(
        events,
        lambda ev: ev.get("event_type") == "llm_message"
        and "tools=Task" in (ev.get("payload", {}).get("summary") or ""),
    )
    first_read = _first_event_ts(
        events,
        lambda ev: ev.get("event_type") == "llm_message"
        and "tools=Read" in (ev.get("payload", {}).get("summary") or ""),
    )
    first_bash = _first_event_ts(
        events,
        lambda ev: ev.get("event_type") == "llm_message"
        and "tools=Bash" in (ev.get("payload", {}).get("summary") or ""),
    )
    first_edit = _first_event_ts(
        events,
        lambda ev: ev.get("event_type") == "llm_message"
        and "tools=Edit" in (ev.get("payload", {}).get("summary") or ""),
    )

    tool_counts = _extract_tool_counts(events)
    read_paths = _extract_read_paths(events)

    per_minute: Dict[datetime, int] = {}
    for ev in events:
        minute = ev["_ts"].replace(second=0, microsecond=0)
        per_minute[minute] = per_minute.get(minute, 0) + 1

    lines: List[str] = []
    lines.append(f"# Sonic Trajectory Report")
    lines.append("")
    lines.append(f"Source: `{path}`")
    lines.append(f"Start: `{start_ts.isoformat()}`")
    lines.append(f"End: `{end_ts.isoformat()}`")
    lines.append(f"Duration: `{duration:.1f}s`")
    lines.append("")
    lines.append("## Milestones")
    lines.append("")
    lines.append("| Event | Time from start |")
    lines.append("| --- | --- |")
    lines.append(f"| prompt_submit | {_format_duration((first_prompt - start_ts).total_seconds() if first_prompt else None)} |")
    lines.append(f"| first_task | {_format_duration((first_task - start_ts).total_seconds() if first_task else None)} |")
    lines.append(f"| first_read | {_format_duration((first_read - start_ts).total_seconds() if first_read else None)} |")
    lines.append(f"| first_bash | {_format_duration((first_bash - start_ts).total_seconds() if first_bash else None)} |")
    lines.append(f"| first_edit | {_format_duration((first_edit - start_ts).total_seconds() if first_edit else None)} |")
    lines.append("")
    lines.append("## Tool Usage")
    lines.append("")
    lines.append("| Tool | Count |")
    lines.append("| --- | --- |")
    for tool, count in tool_counts.most_common():
        lines.append(f"| {tool} | {count} |")
    if not tool_counts:
        lines.append("| - | - |")
    lines.append("")
    lines.append("## Files Read (unique, in order)")
    lines.append("")
    if read_paths:
        for path_item in read_paths:
            lines.append(f"- `{path_item}`")
    else:
        lines.append("- (no read paths captured)")
    lines.append("")
    lines.append("## Activity Per Minute")
    lines.append("")
    lines.append("| Minute (UTC) | Events |")
    lines.append("| --- | --- |")
    for minute in sorted(per_minute.keys()):
        lines.append(f"| {minute.replace(tzinfo=timezone.utc).isoformat()} | {per_minute[minute]} |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize Sonic telemetry JSONL.")
    parser.add_argument("--input", help="Path to sonic JSONL (defaults to latest in test/worker/logs).")
    parser.add_argument("--output", help="Write report to this path (default: stdout).")
    args = parser.parse_args()

    if args.input:
        input_path = Path(args.input)
    else:
        input_path = _find_latest_log(Path("test/worker/logs"))
        if input_path is None:
            raise SystemExit("No telemetry logs found in test/worker/logs.")

    events = _load_events(input_path)
    report = _render_report(input_path, events)

    if args.output:
        output_path = Path(args.output)
        output_path.write_text(report, encoding="utf-8")
    else:
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
