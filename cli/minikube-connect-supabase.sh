#!/usr/bin/env bash
set -euo pipefail

network="${1:-minikube}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not found in PATH." >&2
  exit 1
fi

if ! docker network inspect "$network" >/dev/null 2>&1; then
  echo "Docker network '$network' not found. Start minikube with the docker driver first." >&2
  exit 1
fi

containers=$(docker ps --format '{{.Names}}' | grep '^supabase_' || true)
if [[ -z "$containers" ]]; then
  echo "No running Supabase containers found (expected names like supabase_db_api)." >&2
  exit 1
fi

for name in $containers; do
  if docker network connect "$network" "$name" >/dev/null 2>&1; then
    echo "Connected: $name"
  else
    echo "Already connected: $name"
  fi
done

cat <<EOF
Done.
Use these inside the cluster:
  API_URL=http://supabase_kong_api:8000/functions/v1/api
  QUEUE_DB_URL=postgresql://postgres:postgres@supabase_db_api:5432/postgres?sslmode=disable
EOF
