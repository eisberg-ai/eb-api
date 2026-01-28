# VM MIG PoC (Sandboxer Runtime)

Goal: replace the production Cloud Run runtime with a small GCE VM pool (3 hot VMs) while keeping Cloud Run infra intact for reference.

## Why this
- Cloud Run previews are stored on local instance disk; asset requests can land on a different instance and 404.
- A VM pool gives us per-VM preview hosting and stable asset routing.
- Keep it simple and low cost: e2-small VMs, 3 always-on.

## High-level flow
1. VM boots and runs the sandboxer container on port 8080.
2. VM registers itself with the API (`/vms/register`) using its instance ID + base URL.
3. API allocates an idle VM from the pool and calls `POST <vm>/wake` for builds.
4. VM marks itself idle after build completion (`/vms/release`).
5. Preview URLs point directly to that VM’s base URL.

## Infra (eb-worker)
- Terraform module: `eb-worker/infra/gce-mig`
- Task: `task vm:apply`
- Instance template:
  - COS image (container-optimized OS)
  - public IP per VM
  - container image: `us-central1-docker.pkg.dev/eisberg-ai/eisberg/agent@sha256:...`
  - env vars from `eb-worker/.env.prod` (minus `SANDBOXER_BASE_URL`)
- MIG:
  - min=3, max=6 (cheap pool)
  - machine type: `e2-small`
  - health check `/health` on port 8080

## API changes (eb-api)
- `vms` table is now VM-instance oriented:
  - `instance_id` (unique), `base_url`, `status` (idle/busy/starting/error)
  - `project_id` can be null (assignment)
- New endpoints:
  - `POST /vms/register` (service key)
  - `POST /vms/heartbeat` (service key)
  - `POST /vms/release` (service key)
- `startVm()` now allocates an idle VM and calls its `/wake`.
- No parallel instances per project: if a project has a busy VM, API rejects allocation.

## Runtime changes (eb-worker)
- On boot:
  - fetch instance metadata for `instance_id` + external IP
  - compute `SANDBOXER_BASE_URL` (http://<external-ip>:8080)
  - register + heartbeat
- On build completion:
  - POST `/vms/release` to mark VM idle

## Env vars
In `eb-worker/.env.prod`:
- `API_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `SANDBOXER_AGENT_TYPE` (optional; can override via `/wake`)
- `VM_HEARTBEAT_INTERVAL_SEC=30`

In `eb-api/.env.prod`:
- `VM_HEARTBEAT_TTL_SEC=90` (optional)
- `VM_LEASE_SEC=900` (optional)

## Known footguns
- If the VM registry gets stale, builds will fail. Heartbeats + TTL are mandatory.
- If a VM dies without releasing, API must timeout and reassign.
- Per-project previews depend on stable VM base URL; do not share URLs across VMs.
- Rolling a new image requires a MIG rollout (new template) to pull the image.

## Cloud Run
Cloud Run infra and tasks remain in place for reference, but prod flow now uses VM allocation.
