#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env.prod"
PROJECT_REF="${BACKEND_BASE_PROJECT_REF:-}"

echo "setup-userland: using env file ${ENV_FILE}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "env file not found: ${ENV_FILE}" >&2
  exit 1
fi

tmp_env="$(mktemp)"
cleanup() {
  rm -f "${tmp_env}"
}
trap cleanup EXIT

project_ref_from_env="$(
python3 - <<'PY' "${ENV_FILE}" "${tmp_env}"
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env

def project_ref_from_url(url: str) -> str:
    if not url:
        return ""
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return ""
    if host.endswith(".supabase.co"):
        return host.split(".")[0]
    return ""

env_file = Path(sys.argv[1])
out_file = Path(sys.argv[2])
env = load_env_file(env_file)

for key in (
    "BACKEND_BASE_URL",
    "BACKEND_BASE_ANON_KEY",
    "BACKEND_BASE_SERVICE_ROLE_KEY",
    "BACKEND_BASE_API_URL",
    "BACKEND_BASE_PROJECT_REF",
    "BACKEND_BASE_PROJECT_ID",
):
    if os.environ.get(key):
        env[key] = os.environ[key]

userland_url = env.get("BACKEND_BASE_URL", "")
userland_anon = env.get("BACKEND_BASE_ANON_KEY", "")
userland_service = env.get("BACKEND_BASE_SERVICE_ROLE_KEY", "")
platform_url = env.get("SUPABASE_URL", "")

missing = [k for k, v in {
    "BACKEND_BASE_URL": userland_url,
    "BACKEND_BASE_ANON_KEY": userland_anon,
    "BACKEND_BASE_SERVICE_ROLE_KEY": userland_service,
}.items() if not v]
if missing:
    raise SystemExit(f"missing required keys in {env_file}: {', '.join(missing)}")

userland_ref = (
    env.get("BACKEND_BASE_PROJECT_REF")
    or env.get("BACKEND_BASE_PROJECT_ID")
    or project_ref_from_url(userland_url)
)
platform_ref = project_ref_from_url(platform_url)

if not userland_ref:
    raise SystemExit("missing BACKEND_BASE_PROJECT_REF (or BACKEND_BASE_PROJECT_ID)")
if platform_ref and userland_ref == platform_ref:
    raise SystemExit("userland project ref matches platform SUPABASE_URL; refusing to proceed")
if platform_url.strip("/").lower() == userland_url.strip("/").lower():
    raise SystemExit("userland SUPABASE_URL matches platform SUPABASE_URL; refusing to proceed")

env["SUPABASE_URL"] = userland_url
env["SUPABASE_ANON_KEY"] = userland_anon
env["SUPABASE_SERVICE_ROLE_KEY"] = userland_service
env["API_URL"] = env.get("BACKEND_BASE_API_URL") or f"{userland_url.rstrip('/')}/functions/v1/api"

for key in list(env.keys()):
    if key.startswith("BACKEND_BASE_"):
        env.pop(key, None)

with out_file.open("w", encoding="utf-8") as handle:
    for key in sorted(env.keys()):
        handle.write(f"{key}={env[key]}\n")

print(userland_ref)
PY
)"

if [[ -z "${PROJECT_REF}" ]]; then
  PROJECT_REF="${project_ref_from_env}"
fi

if [[ -z "${PROJECT_REF}" ]]; then
  echo "BACKEND_BASE_PROJECT_REF is required to link the backend Supabase project." >&2
  exit 1
fi

cd "${ROOT}"

supabase link --project-ref "${PROJECT_REF}"
supabase secrets set --env-file "${tmp_env}"
supabase db push
supabase functions deploy api

for fn_dir in "${ROOT}/supabase/functions"/app_*; do
  if [[ -d "${fn_dir}" ]]; then
    supabase functions deploy "$(basename "${fn_dir}")"
  fi
done
