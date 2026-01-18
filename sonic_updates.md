
todo:

workspaces:
- /var/folders/ld/8c7bbb694q5bhprk701l6gg80000gn/T/sonic_demo_9tb37d6v/

tests:
```sh
# fixers
python -m agent.sonic.tests.test_fixers [workspace]
python -m agent.sonic.tests.test_fixers --synthetic
# builder
python -m agent.sonic.tests.test_builder [workspace]
# build plan
python -m agent.sonic.tests.test_build_plan [workspace]
# e2e
python -m agent.sonic.tests.test_e2e --app twitter
python -m agent.sonic.tests.test_e2e --app marketplace
python -m agent.sonic.tests.test_e2e --app notes
python -m agent.sonic.tests.test_e2e --app events
python -m agent.sonic.tests.test_e2e --app flappy
```

- [ ] sonic v1

    - [x] builder/fixer stuff:
        - [x] get pretty strict synthetic fixer tests working
        <!-- - [ ] get real fixer tests working -->
        <!-- - [ ] then update builder prompt to not produce those issues again -->

    - [ ] pipeline:

        - [x] implement background haiku-based status updates
        - [x] updating pipeline logging both at info and debug levels (non-redundant with langfuse and .sonic artifacts)
        - [ ] make sure these features work—definitely will have to update our prompts to them:
            - [ ] message attachments
            - [ ] follow-up requests
            - [ ] agent fixes `expo export` errors after builder is "DONE"
                - [ ] there should of course be some circling back to the builder if the web export step fails - but is there a cheaper way we can test the integrity of the whole app without forcing the web export step?

        - [ ] see if the whole pipeline runs well
            - twitter clone (WORKED, LOOKS LIKE ASS)
            - marketplace (WORKED, LOOKS LIKE ASS)
            - notes (TODO: THIS ONE ERRORED OUT)
            - events
            - flappy bird clone

    - [ ] cluster:
        - [ ] get the new docker image working
        - [ ] update the cluster to use the new pipeline, with the new system requirements because now we're parallel and stuff
        - [ ] measure the langfuse latency in the cluster (it should be lower than it is for me on my farm internet)

    - [ ] check changes in, deploy to prod, update RELEASE.md

    - [ ] have flo test the v1

[check out wyld slack, see what the bug actually is and what we need to fix it]
[tackle the smaller linear tasks flo sent me, and then hit sonic v2]

- sonic v2

    (this will need to be high-IQ thinking with actual coding, because coding assistants will fall short)

    - [ ] agent:

        - [ ] in addition to having dynamically fetched base apps, why not have dynamically fetched base architectures and designs? how different all all of the architectures going to be really?

        - [ ] more intelligent follow-up requests (perhaps not even calling architecture and design agents again)

        - [ ] is it worth it to have some diff feature to see what changes were made? integrating a lightweight git-like system?

        - [ ] for big ambitious app prompts, we need to properly scope the app to be built. the first generation should be a poc, and the subsequent generations should allow the adding of many features
            - maybe we give the user some feedback on what we can build on the first generation
        - [ ] use repo library with great base apps
        - [ ] massive experimentation and optimizations
        - [ ] see how we can condense/combine and/or parallelize the planner, designer, architect, and build plan phases
            - potentially with chain of reasoning?
        - [ ] which parts of the whole pipeline can we defer to haiku?
        - [ ] make sure our langfuse stuff doesn't add latency and uses the BatchSpanProcessor or whatever
        - [ ] make sure we're using the system-message vs user-message split (system = prompt, user = history).

        - [ ] some issues with web exports not supporting certain features—see flo's moms world travel app


    - [ ] cluster:
        - [ ] solve lots of the cluster bugs
        - [ ] make sure pods are always running and ready for work

    - [ ] check in changes

--------------------------------

- [ ] we may want to allow a chain of reasoning/inner monologue (can we enable directly in the api?) to improve results and debugging
<!-- - [ ] we need to have the sonic agent honor the .agentignore stuff, include package-lock.json. it's read this file and we can't have that. -->
<!-- - [ ] status-update agent that reports progress without blocking the build. -->
<!-- - [ ] overall simplification/cleanup pass to make the code a “work of art.” -->
- [ ] build_plan is LLM-generated now; consider deterministic generation from manifest/partition in the future.

completed:
- [x] fix the environment bug: tests run under Rosetta x86_64 Anaconda Python, so bun install/module resolution and native addon selection happen in an x64-tainted environment, but Metro/NativeWind later loads under arm64 Node, causing lightningcss to look for the wrong/missing darwin-x64 .node binary and crash.
- [x] make sure all langfuse stuff is on the same trace for a given agent run (easier debugging)
- [x] make subagents discrete classes with clean IO contracts.
- [x] reduce redundant logs and add useful high-level detaisl, like timing
- [x] move sonic-specific configuration to a separate pydantic datamodel with defaults (yaml loading deferred).
  - [x] each agent phase has its own model/temperature fields in config.
  - [x] cfg + ctx are passed into the pipeline; globals trimmed.
- [x] wipe the .sonic directory after runs.
- [x] use a single context pack across agents (with thin/spec variants).

- [x] tie prior requests into the LangGraph without bloating prompts; pass only needed state forward.
- [x] move spec fan-out/fan-in into LangGraph (design/arch parallel in graph).
- builder agent:
  - [x] stop doing its own planning; rely solely on upstream specs.
  - [x] no repo exploration beyond read/edit/write (no list_dir/grep).
- [x] expose per-phase max token configs in prompts/LLM calls (defaults set).


# 1. plan
scaffolds what needs to be done

- takes the request
- sees if there's an existing app to base off of, or if we're using the default template
- builds context of the repo (prevent agent-based exploration)
- scopes out the changes needed to be made to the app (because we need to note that his is just one wave of changes, not a complete app)

# 2a. arch
determines backend and frontend files, shared state, overall ux flow and structure

- data model
- typescript types
- component hierarchy
- shared state
- file structure and dependency graph
- database schema
- services (API operation setup, potentially given by user as message attachment)
- media (potentially given by user as message attachment)

# 2b. design
picks the aesthetics of the app and design system to use

- ui libraries
- colors
- typography
- spacing
- radius
- effects
- layout patterns
- screens
- components
- data
- styling system

# 3. build plan
takes in the plan, arch, and design to weave them together into a precise, unambiguous, consistent build plan

- what files need to be edited, created, or deleted
- which precise order, what can be parallelized (waves)

the result is a detailed todo list sectioned by waves, exactly what needs to be done to a file (taking details and context from the plan, arch, and design)

# 4. build (parallelized)

just runs the build plan todo list in parallel

for each file,