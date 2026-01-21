# Agent

Agent-only benchmarks (no worker framework). Runs locally with mock endpoints and no real API calls.

## A/B Test Driver

Use this as the core driver for local A/B runs:

```
python -m pytest test/worker/test_agent_features.py -k test_agent_builds_twitter_app -s | tee test/worker/logs/test_agent_builds_twitter_app_$(uuidgen).log
```

## Baselines (Version 1)

### Mock (`handle_job`)
_5 runs_

| Step | Min | Max | Avg |
| --- | --- | --- | --- |
| setup_context | 0.002 | 0.003 | 0.0022 |
| restore_source | 0.0 | 0.001 | 0.0004 |
| prepare_inputs | 0.0 | 0.0 | 0.0 |
| install_dependencies | 7.603 | 8.142 | 7.9058 |
| build_app | 15.548 | 17.499 | 16.468 |
| finalize_build | 39.578 | 41.644 | 40.5726 |
| total | 63.878 | 66.085 | 64.9542 |

### Default (`driver`)
_1 run_

| Step | Duration (s) |
| --- | --- |
| setup_context | 0.003 |
| restore_source | 0.0 |
| prepare_inputs | 0.0 |
| install_dependencies | 8.171 |
| build_app | 358.882 |
| finalize_build | 40.855 |
| total | 407.915 |

### Default (`run_agent_loop`)
total: 310s

## Models

Opus, Sonnet, Haiku - `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`

## Experiments

These also use `run_agent_loop`

### Default (Baseline)

416.4s
- /var/folders/ld/8c7bbb694q5bhprk701l6gg80000gn/T/tmpepj7m7so/twitter_app/base/dist
- test/worker/logs/test_agent_builds_twitter_app_default_20260109_162112.log


### Minny
haiku + clamp llm budgets/tokens + lower reasoning effort

#### Builds
210 seconds
- /private/var/folders/ld/8c7bbb694q5bhprk701l6gg80000gn/T/pytest-of-lkwbr/pytest-32/test_agent_builds_twitter_app0/twitter_app/base/dist
- test/worker/logs/test_agent_builds_twitter_app_38EA5DAA-9F4C-4DBA-A2F3-7F0E70329E59.log

### Sonic

#### Builds

### Tails


TODO: Friday
- Run the default agent again, capture the log. Use this as a baseline for how we should do planning/exploration in our state machine. Compare the plans, exploration, and actual implementation steps. Make sure it's running in its restored state.
- Give Tails the old college try:
    - See why the Tails agent errored out.
    - Check out the Claude Agent SDK
    - Make sure it's implemented how we want, with minimal agent calls and "manual" steps. Make sure the reasoning and LLM token budgets are adjusted for each phase too.
    - Try and get the prompting and state machine logic really good.
    - Try and get the implementation agents to run in parallel.
    - We'll also need to be mindful of including the message attachments in muliple phases
- Investigate different techniques:

Practical state machine that fits current OpenHands constraints (single editor, no parallel tool writes).

- Plan phase (fast model, 1 turn): short, structured plan + tentative file list + acceptance checks.
- Implement phase (strong model, sequential batches): apply changes in larger batches to reduce LLM calls; single editor.
- Verify phase (fast model + fallback): run `tsc` + `expo export`; triage with fast model, escalate to strong model on errors.
- Package phase: always run export once; only loop on failure.

### Sonic

State machine with very specific coding-agent/openhands usage. The idea is to minimize the number of LLM calls and use each model for the most appropriate task.

- Plan phase: architecture, DB, routing, and design; one-shot (higher reasoning)
    - We feed in the current project structure and basic high-level information about the project, packages, and frameworks.
    - This tells us all of the files
- Implementation phase: write the code; one-shot (mid-reasoning, uses sonnet's stylistic taste)
    - These would all write in parallel. A challenge here would likely be inconsistency in design and interface between the files.
- Follow-through phase: make sure the code doesn't have any errors (low-reasoning, uses fast haiku model)
    - This would also run in parallel.
    - Only involve an agent if there's some linting error.
- Packaging phase: create a web-build of the app (low-reasoning, haiku)
    - Run expo build
    - Only involve an agent if there's an error

### Experiments

1. Clamp LLM budgets + lower reasoning (max output 2k-6k, reasoning effort medium/low, disable extended thinking unless required).
2. Slim prompts and avoid base64 inlined attachments (cache dir overview, replace inline file contents with a manifest, use image refs/URLs).
3. Enforce hard time + iteration caps with early-stop heuristics.
4. Reduce LLM call count (collapse plan/execute, batch tool ops).
5. Model routing (fast coordinator vs strong coder).
6. Parallelize independent tool calls.
7. Tighten retries + add fast fallback on slow/ratelimited calls.
8. Speed-oriented system prompt (concise, minimal narration, ship fast).

## Potential Prompt Updates

- Add “view before replace” and “use small, anchored replacements” rules to reduce failed edits and recovery loops (we saw failed `str_replace` causing extra tool calls and time).

## References

- Deep research report: [agent_speedup_research.md](agent_speedup_research.md)
