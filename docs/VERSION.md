# 0.1 (completed tuesday)
- [x] generate an e2e prototype using a basic dsl approach
    - one-shot LLM response to generate the app
    - runs locally on ios simulator + nextjs web app
    - decent component library

# 0.2 (completed wednesday)
- [x] update system to use sandbox approach
    - llm ships react native code
    - fairly large component library + styling + theming + local database API
- [x] update LLM to be a multi-step designer agent (chat + design + code)
- [x] simplify web app to just be a chat interface

# 0.3 (completed thursday)
- [x] implement proper backend for the app
    - supabase
    - vercel pro
- [x] improve designer agent and frontend integration
- [x] improve project structure and architecture
- [x] fix sandbox approach issues

# 0.4 (completed friday)
- [x] create containerized worker which test-builds and serves web preview
    - gcs for static web preview hosting
    - docker for worker container
    - offline- and online-mode for worker ai agent
- [x] migrate backend paradigm to "warp"
- [x] merge flo's frontend with my frontend, hook up basic backend

# 0.5 (completed saturday)
- [x] implement enhanced llm stack: langfuse, litellm, pydantic, qdrant
- [x] improve custom-built agent architecture

# 0.6 (completed sunday)
- [x] replace coding agent with openhands
- [x] upgrade `base` expo app
- [x] agent works well end-to-end

# 0.6.1 (completed monday)
- [x] implement light/dark mode toggle in user settings
- [x] solve error: `Error: Found config at base/metro.config.js that could not be loaded with Node.js`
    - due to different arch arm64 vs x64 with the pre-built `node_modules`
    - migrated from bun to npx for now
- [x] upgraded data model, improve API-agent integration
    - mock agent implemented for emulation
    - api using more supabase features
    - upgrade database schema
- [x] add user registration and authentication
- [x] deploy: web app to vercel, api to supabase
- [x] single turn e2e chat works (with mock agent)

# 0.6.2 (completed tuesday)
- [x] app is available at https://eisberg.vercel.app and works
- [x] fix some web app bugs
- [x] flesh out core project features
    - gallery
    - auto-naming and name edit
    - persistence/resuming
    - deletion

# 0.6.3 (completed wednesday)
_main flow works most of the time_
- [x] crushing bugs
    - chat message ordering is fucked
    - google sign-in stopped working
    - chat persistence is all fucked up
    - refreshing the page on chat interface takes you to dashboard
    - replace logos with real ones
    - phone preview is smooshed together
- [x] "staged project" feature
    - this helps us edit a project's settings before submitting a chat, which helps test the ai app building with a one-shot prompt
- [x] privacy policy and terms of service

# 0.6.4 (completed thursday)
_official eisberg.ai launch with waitlist_
- [x] after a week of luke shooting down ideas, we decide with eisberg.ai - quick and dirty rebrand on website. still needs more work.
- [x] waitlist feature with a whitelist (prevent abuse)
- [x] add socials to the website, drop affiliates link, update emails to team@eisberg.ai
- [x] turn ui to glass ui (still more work needed)
- [x] modularize `App.tsx`, update app routing logic, particularly for the waitlist page
- [x] modularize api backend logic
- [x] update data model and platform features (untested):
    - implement workspaces and public/private projects
    - model level selector and mapping + agent version tracking
    - project status tracking
- [x] bugs:
    - waitlist logic is buggy, shows the chat view
    - https://www.eisberg.ai/[subroute] show a 404 not found from vercel
- [x] implement user analytics (via vercel)
- [x] basic agent speedup attempts, prompt module updates, etc. (untested)
    - deep prompt research: https://chatgpt.com/share/693adce1-6a94-8009-8f0a-5a8e62798784

# 0.6.5 (completed friday)
_prove claude sonnet + my updated prompt works and streams well to mobile_
- [x] update agent: validate claude sonnet outputs, make agent multimodal, and using image as design reference
- [x] update mobile: get emulator working with webview (on local network host), then deploy to testflight for testing

# 0.6.6 (completed saturday)
- [x] refactor the api routes and add
    - chat endpoint
    - media and services endpoint
    - billing and credits
    - setting which LLM to use
- [x] partially upgrade web app with new api

# 0.6.7 (completed sunday)
_getting closer to working web app_
- [x] add personal workspaces
- [x] test and integrate new API with web app
- [x] add message attachments
    - media
        - image
        - audio
        - files
    - services
    - haptics
    - payments
    - ...and more
- [x] add analytics and cookie consent
    - posthog
    - google tag manager
    - iubenda
    - meta
- [x] voice to text (not working on localhost)

# 0.6.8 (completed sunday)
_(there was a hiatus while luke was traveling from marbella -> rome -> queens -> dallas -> austin. started serious work again on thursday.)_
- [x] hide hideous "cookies" footer, use our own
- [x] convert camel case to snake case in the db
- [x] implement new pricing and charging system
    - [x] change three (paid) plans: free, plus, pro, max
    - [x] change build charging to be pay-as-you-go instead of fixed amount, stopping build halfway if you run out of credits
    - [x] warn them if credits are possibly too low to finish the build
    - [x] fix initial credit balance and workspace creation issue
    - [x] handle insufficient credits for build as well as message retries
- [x] lots and lots of debugging
- [x] fix web preview (vector) icon issue
- [x] small stuff
    - [x] make uploaded assets (media/files) preselected in the composer
    - [x] upload animation when attaching files or media isn't working anymore (maybe it was just for drag and drop?)
    - [x] make the model stubs more compact and consistent in the composer

# 0.6.9 (completed sunday)
_get the web app working really well and seamless, so we can take that stable api-client connection and use it for mobile_
- [x] ensure worker is using the new api routes and message shit
    - [x] previous version retrieval
    - [x] message attachments
    - [x] LLM charging & credits
    - [x] design reference images

# 0.6.10 (completed monday)
_frontend in a good place for a pre-release_
- [x] dashboard composer updates
    - draft projects
    - update layout, create reusable and conditionally styled composer component
    - private/public project toggle logic
    - restrict models available
- [x] project version control ui
    - fix blank screen
    - create single dropdown
    - more build information
    - revert and preview old versions
- [x] disable features that don't currently work

# 0.6.11 (completed tuesday)
- [x] ensure deployed web app mostly works for flo to test
    - [x] llm usage charging
    - [x] web preview via hooking up api.eisberg.ai (that was a bitch)
    - [x] remove typing animation
    - [x] if there are no projects, the project gallery below should be hidden
    - [x] make the mobile app landing page look a bit better, both on mobile and desktop
    - [x] implement promo code feature
- [x] changed how staged projects are handled in web and mobile
- [x] finish up the mobile app, based on flo's template design
    - [x] auth page + new logo
    - [x] waitlist logic
    - [x] disable unimplemented features
    - [x] rename from aether to eisberg
    - [x] hook up all web features via backend API client (which I would like to share with the web app)
    - [x] project gallery
    - [x] some composer work: control/preview mode

# 0.6.12 (completed wednesday)
- [x] finish up the mobile app alpha release
    - [x] billing and upgrade/downgrade logic
    - [x] modularize the code
    - [x] control vs preview mode in editor
    - [x] both composers + creating new project
    - [x] account settings
    - [x] project settings
- [x] deploy to testflight via expo

# 0.6.13 (completed sunday)
_make the testflight app work_
- [x] fixed testflight issues, environment variables and whatnot

# 0.6.14 (completed wednesday, 7.1.26)
_can alpha "soft" launch app_
agent:
- [x] parallel workers: create auto-scalable, cloud-ambivalent kubernetes setup
    - [x] docker (local)
    - [x] minikube (local)
    - [x] gke (cloud)
        - scales to 200 parallel jobs
        - 50 CPUs available
        - recovery from errors
- [x] add LLM-based agent task tracking
- [x] improved follow-up requests
- [x] scalability tests
- [x] made `eb` devops tool (eisberg cli)
- [x] disable model selection in the UI (defaulting us to claude sonnet 3.5)

web:
- [x] "eisberg virus" fix
- [x] admin panel + admin users
- [x] aesthetic updates

both mobile and web:
- [x] add credit top-up feature, disable plans for now
- [x] add spoofed app deployment feature with support button on the last step
- [x] make sure you can rapid-fire submit projects (frontend bug)

# 0.6.15 (completed wednesday, 14.1.26)
_implement most of sonic v1 - work was cut short due to other work building up_

agent:
- [x] implement sonic agent: new langgraph-based parallel pipeline architecture
    - [x] sequential → parallel builder with wave-based execution
    - [x] subagents: plan, arch, design, build_plan, builder, test, fix
    - [x] parallel design/arch spec generation (fan-out/fan-in)
    - [x] pydantic config model with per-phase model/temperature settings
    - [x] context pack system (thin/spec variants)
    - [x] node wrapping for status/logging instrumentation
- [x] implement background haiku-based status updates (non-blocking)
- [x] structured logging with artifact tracking (.sonic directory)
- [x] package installation node in pipeline
- [x] attachment and image context support across all prompts
- [x] edit instruction handling for existing apps
- [x] fix bun install architecture issue: track architecture in marker file to avoid reinstalling when arch matches
- [x] upgrade TypeScript checks to be scoped to specific files (temporary tsconfig override)
- [x] fix environment bug: tests run under Rosetta x86_64 Anaconda Python, so bun install/module resolution and native addon selection happen in an x64-tainted environment, but Metro/NativeWind later loads under arm64 Node, causing lightningcss to look for the wrong/missing darwin-x64 .node binary and crash
- [x] make subagents discrete classes with clean IO contracts
- [x] reduce redundant logs and add useful high-level details, like timing
- [x] wipe the .sonic directory after runs
- [x] tie prior requests into the LangGraph without bloating prompts; pass only needed state forward
- [x] builder agent: stop doing its own planning; rely solely on upstream specs
- [x] builder agent: no repo exploration beyond read/edit/write (no list_dir/grep)
- [x] expose per-phase max token configs in prompts/LLM calls (defaults set)
- [x] synthetic fixer tests working
- [x] e2e test suite (twitter, marketplace, notes, events, flappy)
- [x] message attachments implemented (attachment_context and image_context passed through pipeline)

all this got our average build time down to 1.5 minutes, not including the pre-planning phases.

*still TODO for sonic v1*:
- retries on build failures (untested)
- follow-up requests (untested)
- small fixer improvements, such as giving the fixer the new _projected_ file system, libraries, and whatnot. also how to solve the `{ Lib }` vs `Lib` import issue.

# 0.6.16 (completed thursday, 15.1.26)
_quick detour off sonic to solve platform bugs_

mobile:
- [x] fix: google sign-in on mobile app (feature regression)
- [x] fix: black screen after deleting project on mobile app
- [x] fix: log-out and log-in lands on settings, not home
- [x] fix: expand prompt input field on mobile
- [x] ux: composer input and attachments selection/focus logic
- [x] ux: update API, image, and file composer tabs
- [x] ux: disable model selection in composer
- [x] ux: update chat to show our message attachments a la the web app + other updates
- [x] ux: improve build progress UI
- [x] ux: update home page
- [x] system: have mobile use SSE instead of polling
- [x] fix: the mobile app doesn't upload message attachments!
- [x] ux: project and app settings looked like ass (they still do tho)
- [x] ux: update the experience for when a message is sent (from both composers)
- [x] ux: import app publish page update and add api-backed statefulness
- [x] fix: actually track if a user has read a series of messages instead of just making them seem unread each time

mobile+web:
- [x] fix: use new task status schema

# 0.6.17 (completed friday, 16.1.26)
_second batch of platform features_

mobile:
- [x] ux: implement loading state for the project view page
- [x] ux: update home page
- [x] ux: update build failure display, allow for top-up (like web)
- [x] feature: limited mobile admin dashboard
- [x] ux: decluttered settings tabs
- [x] feature: allow user to select build version in publishing page
- [x] ux: fix inconsistent navbars and nav buttons
- [x] ux: update project view navbar

platform:
- [x] feature: admin stuff (with tests):
    - [x] invite code-based sign ups (from admins and users)
    - [x] promo code generation and management
    - [x] approve/deny control panel
- [x] feature: app sharing within platform

# 0.6.18 (completed saturday, 17.1.26)
_wrap-up app testing and finish sonic v1_

mobile:
- [x] fix: white screen of death on testflight version
    - it was native autolinking going stale
- [x] ux: settings tab design
- [x] ux: cleaner home page animation
- [x] ux: login page animation
- [x] ux: update app preview page look and feel
- [x] fix: share feature not working
- [x] deploy: app and backend

web:
- [x] fix: admin user approvals not implemented

backend:
- [x] feature: app templates

--------------------------------

At this point, we've officially moved to Linear for our task tracking and planning.
