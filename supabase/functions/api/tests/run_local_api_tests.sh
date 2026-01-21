#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"
SUPABASE_DIR="${REPO_ROOT}/api/supabase"
TESTS_DIR="${SCRIPT_DIR}"

# allow running specific test file or all tests
if [[ -n "${1:-}" ]]; then
  TEST_FILE="${TESTS_DIR}/${1}"
else
  TEST_FILE="${TESTS_DIR}/*.test.mjs"
fi

started_here=0

if ! status_json="$(supabase status --output json --workdir "${SUPABASE_DIR}" 2>/dev/null)"; then
  supabase start --workdir "${SUPABASE_DIR}"
  started_here=1
  status_json="$(supabase status --output json --workdir "${SUPABASE_DIR}")"
fi

if [[ "${RESET_DB:-0}" == "1" ]]; then
  supabase db reset --workdir "${SUPABASE_DIR}" --yes
  status_json="$(supabase status --output json --workdir "${SUPABASE_DIR}")"
fi

export SUPABASE_URL
export SUPABASE_ANON_KEY
export SUPABASE_SERVICE_ROLE_KEY

SUPABASE_URL="$(echo "${status_json}" | jq -r '.API_URL')"
SUPABASE_ANON_KEY="$(echo "${status_json}" | jq -r '.ANON_KEY')"
SUPABASE_SERVICE_ROLE_KEY="$(echo "${status_json}" | jq -r '.SERVICE_ROLE_KEY')"

node --test "${TEST_FILE}"

if [[ "${started_here}" == "1" && "${SUPABASE_KEEP_RUNNING:-0}" != "1" ]]; then
  supabase stop --workdir "${SUPABASE_DIR}"
fi
