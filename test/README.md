# API Integration Tests

python integration tests for the eisberg api.

## setup

```bash
# ensure supabase is running
cd ../supabase
supabase start

# install python dependencies (if not already done)
pip install pytest requests
```

## running tests

### all tests

```bash
pytest test/
```

### specific test file

```bash
pytest test/test_message_staging.py
```

### specific test

```bash
pytest test/test_message_staging.py::test_staged_build_creation
```

### with verbose output

```bash
pytest -v test/
```

## environment

tests require the following environment variables (automatically read from supabase):

- `SUPABASE_URL` - supabase instance url (default: http://127.0.0.1:54321)
- `SUPABASE_SERVICE_ROLE_KEY` - service role key for admin operations

if running against a non-local instance:

```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=your-service-key
pytest test/
```

## test files

- `test_api_worker_flow.py` - basic api and worker job flow
- `test_api_invite_promo_codes.py` - invite codes and promo codes
- `test_message_staging.py` - message staging/queueing feature

## test coverage

message staging tests cover:

- staged build creation when build is active
- max 3 staged builds limit
- fetching staged builds via api
- deleting staged builds with chain repair
- automatic promotion when dependency succeeds
- failed build blocking new messages
- preserving attachments in staged builds
- staging build ordering
