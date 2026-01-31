#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "${TEST_DIR}/.." && pwd)"
NODE_TESTS_DIR="${TEST_DIR}/node"

if [[ ! -d "${NODE_TESTS_DIR}" ]] || ! compgen -G "${NODE_TESTS_DIR}/*.test.mjs" > /dev/null; then
  echo "No node tests found at ${NODE_TESTS_DIR}. Use pytest test/ instead." >&2
  exit 1
fi

if [[ -n "${1:-}" ]]; then
  TEST_FILE="${NODE_TESTS_DIR}/${1}"
else
  TEST_FILE="${NODE_TESTS_DIR}/*.test.mjs"
fi

started_here=0

if [[ "${RESET_DB:-0}" == "1" ]]; then
  if ! status_json="$(supabase status --output json --workdir "${API_ROOT}" 2>/dev/null)"; then
    supabase start --ignore-health-check --workdir "${API_ROOT}"
    started_here=1
    supabase db reset --workdir "${API_ROOT}" --yes
  else
    supabase db reset --workdir "${API_ROOT}" --yes
  fi
  status_json="$(supabase status --output json --workdir "${API_ROOT}")"
else
  if ! status_json="$(supabase status --output json --workdir "${API_ROOT}" 2>/dev/null)"; then
    supabase start --workdir "${API_ROOT}"
    started_here=1
    status_json="$(supabase status --output json --workdir "${API_ROOT}")"
  fi
fi

export SUPABASE_URL
export SUPABASE_ANON_KEY
export SUPABASE_SERVICE_ROLE_KEY

SUPABASE_URL="$(echo "${status_json}" | jq -r '.API_URL')"
SUPABASE_ANON_KEY="$(echo "${status_json}" | jq -r '.ANON_KEY')"
SUPABASE_SERVICE_ROLE_KEY="$(echo "${status_json}" | jq -r '.SERVICE_ROLE_KEY')"

node --test "${TEST_FILE}"

if [[ "${started_here}" == "1" && "${SUPABASE_KEEP_RUNNING:-0}" != "1" ]]; then
  supabase stop --workdir "${API_ROOT}"
fi
