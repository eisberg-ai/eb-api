From the log + worker/src/agent/default.py, your latency pain points are mostly self-inflicted: you’re handing the model a fat prompt, letting it “think” forever, and you’ve disabled the mechanisms that make agents feel fast.

Here’s what jumps out, in descending “holy shit fix this” order.

1) Your token / thinking budgets are absurdly high

Log shows:
	•	max_input_tokens: 200000
	•	max_output_tokens: 64000
	•	reasoning_effort: "high"
	•	extended_thinking_budget: 200000

That combo is basically: “please do a dissertation every turn.” Even if the model doesn’t always use it, providers often change behavior when you allow massive deliberation. It increases tail latency and makes the agent verbose/overcautious.

Highest leverage fix
	•	Clamp output hard (e.g. 2k–6k)
	•	Lower reasoning effort (medium/low)
	•	Remove/disable extended thinking budget unless you’re doing deep planning tasks

This alone can be a 2–5× latency win.

2) You turned streaming off

stream: False

So you pay full wall-clock before the user sees anything, and you can’t pipeline (e.g. start parsing tool calls or begin next steps early).

Highest leverage fix
	•	Turn streaming on for user-visible interactions.
Even if you can’t fully “act on partial tokens,” streaming dramatically improves perceived latency and reduces timeouts/abandonment. And it often reduces your own orchestration overhead because you can early-terminate once you’ve gotten what you need.

3) You’re bloating the prompt every run (redundant + expensive context building)

In _build_openhands_prompt() you inject:
	•	a directory overview (computed by walking the filesystem)
	•	attachment context (reads file contents into the prompt up to 8k chars total)
	•	image context (and _prepare_image_inputs base64-encodes local images into data URIs)

That’s a lot of crap to send every time.

Specific pain points
	•	_build_dir_overview(base_dir) is duplicated work because your “authoritative” user prompt already includes a directory overview.
	•	_read_attachment_text can quietly dump huge chunks of code/text into the LLM context.
	•	Base64 image data URIs are token poison (massive + slow). Vision models don’t need you to inline base64 unless you absolutely must.

Highest leverage fixes
	•	Cache the dir overview per workspace (or stop generating it if the user prompt already provides it).
	•	Don’t inline file contents in the prompt by default; instead pass a manifest and let the agent read files via tool calls when needed.
	•	For images: prefer file paths / uploaded URLs supported by the SDK, not base64 in the prompt.

4) Retry policy is tuned for “never fail,” not “be fast”

Log shows:
	•	num_retries: 5
	•	retry_multiplier: 8.0
	•	waits up to 64s

That creates brutal tail latency when anything glitches (provider hiccup, transient 429, network blip). In production, tail latency is what users experience as “this app is slow as fuck.”

Highest leverage fix
	•	Replace exponential backoff with a tighter budget:
	•	fewer retries (1–2)
	•	shorter max wait (e.g. 8–12s)
	•	fail fast + fallback to another model/provider when a call is slow/ratelimited

5) You only use one model for everything (no routing)

Your code has a model-level map, but LLM_ALIAS_TO_MODEL maps basically everything to deepseek/deepseek-chat, and your example run is claude-sonnet-4-5. There’s no task-based routing: planning, patching, summarizing, formatting, etc. all hit the same big model.

Highest leverage fix
Split the loop into phases with different models:
	•	fast model for: planning, file triage, “what to open next”, summarizing logs
	•	smart model for: final code edits / architecture decisions
	•	optionally a cheap verifier for: lint/typecheck interpretation + quick fixes

This tends to cut LLM time a lot because most agent turns are “coordination,” not “deep reasoning.”

6) Conversation.run() is fully blocking and you don’t pipeline tool work

conversation.run() blocks; you can’t overlap tool execution, file polling, or prefetching.

You do have a polling thread for .build_tasks.json, but that doesn’t reduce latency; it’s just UI progress.

Highest leverage fix
If the SDK allows it: move toward a loop where you:
	•	stream tokens
	•	detect tool calls early
	•	run independent tool calls concurrently (terminal/file reads)
	•	feed results back in batches

Even without full concurrency, batching tool ops helps (one terminal call that runs multiple commands, one file read that grabs multiple files).

7) No strict step/time budgets per build

You pass max_iterations: 500 in conversation state (seen in log). That’s insane for production. You need a wall-clock “time budget” and a hard cap on tool calls / iterations, otherwise a “slow” run becomes a multi-minute zombie.

Highest leverage fix
	•	set a sane default like 30–60 iterations max
	•	enforce a wall-clock timeout per build (e.g. 2–5 minutes)
	•	implement early-stop heuristics (if no new files changed in N steps, or repeated actions)

8) Prompt content pushes “quality over speed” while you say you want speed

Your OpenHands system prompt includes “thorough, methodical, prioritize quality over speed.”
That nudges the agent to be conservative and verbose.

Highest leverage fix
You want a production “build agent” persona:
	•	minimal narration
	•	aggressive batching
	•	tight budgets
	•	explicit “ship fast” constraints

Even small changes in system prompt can meaningfully reduce token output and deliberation.

⸻

The top 5 changes I’d do first (biggest latency wins)
	1.	Clamp tokens + lower reasoning (kill the 64k output / 200k thinking insanity).
	2.	Enable streaming.
	3.	Stop inlining attachments + base64 images; use manifests + tool reads + proper image refs.
	4.	Introduce model routing (fast coordinator + strong coder).
	5.	Tighten retries + add fallback (optimize tail latency).

If you want, I can propose an exact patch to DefaultAgent/run_agent_loop that implements (1) budgets, (3) prompt slimming, (4) routing, and (7) time/step caps.