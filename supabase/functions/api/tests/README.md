# API Tests

integration tests for the eisberg api using node's built-in test runner.

## running tests

### all tests

```bash
./run_local_api_tests.sh
```

### specific test file

```bash
./run_local_api_tests.sh api_features.test.mjs
./run_local_api_tests.sh message_staging.test.mjs
```

### with database reset

```bash
RESET_DB=1 ./run_local_api_tests.sh
```

### keep supabase running after tests

```bash
SUPABASE_KEEP_RUNNING=1 ./run_local_api_tests.sh
```

## test files

- `api_features.test.mjs` - tests for invites, promo codes, and access control
- `message_staging.test.mjs` - tests for message staging/queueing feature

## writing tests

tests use node's built-in `node:test` and `node:assert/strict` modules.

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';

test('description', async () => {
  // test code
  assert.equal(actual, expected);
});
```

helper functions available:
- `signUpUser(prefix)` - creates a new user
- `approveUser(userId)` - approves user for access
- `requestJson(url, options)` - makes authenticated api requests

## requirements

- supabase cli installed
- jq (for json parsing in bash)
- node.js

the test script will automatically start/stop supabase if needed.
