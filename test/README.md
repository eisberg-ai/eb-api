# API Integration Tests

Python and Node integration tests for the eisberg api (auth, functions, db).

## setup

```bash
# from eb-api root
cd ..
supabase start   # or run_node_api_tests.sh will start it

pip install pytest requests   # for python tests
```

## python tests

### run all

```bash
pytest test/
```

### run one file / one test

```bash
pytest test/test_message_staging.py
pytest test/test_message_staging.py::test_staged_build_creation
pytest -v test/
```

### environment

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (read from supabase if local)
- for remote: `export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...` then `pytest test/`
- for backend tests on a separate project, set `BACKEND_BASE_URL`, `BACKEND_BASE_ANON_KEY`, `BACKEND_BASE_SERVICE_ROLE_KEY` (optional `BACKEND_BASE_API_URL`) in `.env.prod` or your shell; they override the standard `SUPABASE_*` values for tests

### python test files

- `test_api_worker_flow.py` - api and worker job flow
- `test_api_invite_promo_codes.py` - invite and promo codes
- `test_message_staging.py` - message staging/queueing
- `test_api_build_preview_flow.py` - build preview flow
- `services/test_service_text.py` - text service proxies (requires service keys)
- `services/test_service_audio.py` - audio service proxies
- `services/test_service_image.py` - image service proxies
- `services/test_service_video.py` - video service proxies
- `services/test_service_data.py` - data service proxies
- `services/test_service_lifecycle.py` - full text service lifecycle + all-services smoke

### python userland tests (`test/userland/`)

Same coverage as node tests but in pytest (invite/promo/waitlist, message staging). Use auth/v1 signup + anon key.

```bash
pytest test/userland/
pytest test/userland/test_api_features.py
```

Requires `SUPABASE_ANON_KEY` (and `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). Export from `supabase status` or `.env.local`.

- `test_api_features.py` - invite join method, promo join method, waitlist gate
- `test_message_staging.py` - first/follow-up staged, max 3, get/promote/delete chain, attachments, failed blocks, order

### userland setup (remote project)

To deploy migrations/functions and set secrets for a separate userland project,
use the setup script in eb-userland:

```bash
cd ../eb-userland
BACKEND_BASE_PROJECT_REF=... task setup:remote
```

`BACKEND_BASE_PROJECT_REF` (or `BACKEND_BASE_PROJECT_ID`) can be in your shell or `.env.prod`.

## legacy node tests

Userland node tests were migrated to pytest. The old references live in
Use `pytest test/`
for integration coverage.
