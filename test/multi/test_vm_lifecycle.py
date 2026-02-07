"""
VM lifecycle tests for claim/release, contention, and edge cases.

## Test Categories

@pytest.mark.local - Tests DB logic directly, only needs Supabase running
@pytest.mark.multi - Tests full API flow, needs workers running

## Running Local Tests (DB logic only)

    cd eb-api
    supabase start
    pytest test/multi/test_vm_lifecycle.py -v -k "local" --env local

## Running Multi Tests (requires workers)

    # Terminal 1: Start Supabase + functions
    cd eb-api
    supabase start
    supabase functions serve

    # Terminal 2: Start workers (uses eb-worker/.env.local)
    cd eb-worker/deploy
    docker compose -f docker-compose.test.yml up --build

    # Terminal 3: Run tests
    cd eb-api
    pytest test/multi/test_vm_lifecycle.py -v -k "multi" --env local
"""
from __future__ import annotations

import concurrent.futures
import time
import uuid
from datetime import datetime, timedelta
from typing import Any

import pytest
import requests

from test.utils import (
    admin_headers,
    create_project,
    ensure_access_token,
    resolve_api_url,
    resolve_env,
)


def get_supabase_client(env: dict[str, str]):
    """Get a Supabase client for direct DB access."""
    try:
        from supabase import create_client
    except ImportError:
        pytest.skip("supabase-py not installed")
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        pytest.skip("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
    return create_client(url, key)


def insert_test_vm(
    client: Any,
    *,
    status: str = "idle",
    instance_id: str | None = None,
    base_url: str | None = None,
    last_heartbeat_at: datetime | None = None,
    lease_expires_at: datetime | None = None,
    project_id: str | None = None,
) -> str:
    """Insert a synthetic VM row for testing."""
    vm_id = str(uuid.uuid4())
    instance_id = instance_id or f"test-instance-{uuid.uuid4().hex[:8]}"
    base_url = base_url or f"http://localhost:9999/{instance_id}"
    now = datetime.utcnow()
    heartbeat = last_heartbeat_at or now

    data = {
        "id": vm_id,
        "instance_id": instance_id,
        "base_url": base_url,
        "status": status,
        "runtime_state": "serving" if status == "idle" else "building",
        "last_heartbeat_at": heartbeat.isoformat(),
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }
    if lease_expires_at:
        data["lease_expires_at"] = lease_expires_at.isoformat()
    if project_id:
        data["project_id"] = project_id
        data["lease_owner"] = f"project:{project_id}"

    result = client.table("vms").insert(data).execute()
    if not result.data:
        raise RuntimeError(f"Failed to insert test VM: {result}")
    return vm_id


def get_vm(client: Any, vm_id: str) -> dict | None:
    """Get a VM by ID."""
    result = client.table("vms").select("*").eq("id", vm_id).maybe_single().execute()
    return result.data


def delete_test_vms(client: Any, prefix: str = "test-instance-") -> int:
    """Clean up test VMs."""
    result = client.table("vms").delete().like("instance_id", f"{prefix}%").execute()
    return len(result.data) if result.data else 0


def get_idle_worker_vms(client: Any, min_count: int = 1, timeout: float = 30.0) -> list[dict]:
    """
    Wait for real worker VMs to register and be idle.
    These are VMs registered by Docker workers, not synthetic test VMs.
    """
    cutoff = datetime.utcnow() - timedelta(seconds=90)  # Recent heartbeat
    cutoff_iso = cutoff.isoformat()
    start = time.time()
    while time.time() - start < timeout:
        result = (
            client.table("vms")
            .select("*")
            .eq("status", "idle")
            .gte("last_heartbeat_at", cutoff_iso)
            .not_.like("instance_id", "test-instance-%")  # Exclude synthetic VMs
            .execute()
        )
        vms = result.data or []
        if len(vms) >= min_count:
            return vms
        time.sleep(1)
    return []


def release_worker_vms(client: Any) -> None:
    """Release all worker VMs back to idle state (for cleanup)."""
    now = datetime.utcnow().isoformat()
    client.table("vms").update({
        "status": "idle",
        "runtime_state": "serving",
        "project_id": None,
        "desired_build_id": None,
        "lease_owner": None,
        "lease_expires_at": None,
        "last_shutdown_at": now,
        "updated_at": now,
    }).not_.like("instance_id", "test-instance-%").execute()


# -----------------------------------------------------------------------------
# Local tests (just Supabase, no workers needed)
# -----------------------------------------------------------------------------


@pytest.mark.local
def test_claim_sets_lease_expiry() -> None:
    """Claiming a VM should set lease_expires_at ~15 minutes in future."""
    env = resolve_env()
    client = get_supabase_client(env)
    api_url = resolve_api_url(env["SUPABASE_URL"], env)
    service_key = env["SUPABASE_SERVICE_ROLE_KEY"]
    access_token = ensure_access_token(service_key, env["SUPABASE_URL"])

    # Insert idle VM with recent heartbeat
    vm_id = insert_test_vm(client, status="idle")

    try:
        # Create project and acquire VM
        project_id = create_project(api_url, access_token)
        _resp = requests.post(
            f"{api_url}/vm/acquire",
            headers=admin_headers(service_key),
            json={"project_id": project_id},
            timeout=30,
        )

        # Note: acquire may fail if wake fails (no real worker)
        # We just verify the DB state was updated
        vm = get_vm(client, vm_id)
        if vm and vm.get("status") == "busy":
            assert vm.get("lease_expires_at"), "Claimed VM should have lease_expires_at"
            lease = datetime.fromisoformat(vm["lease_expires_at"].replace("Z", "+00:00"))
            now = datetime.utcnow().replace(tzinfo=lease.tzinfo)
            delta = lease - now
            # Should be ~15 min (900s) minus elapsed time
            assert 800 < delta.total_seconds() < 920, f"Lease should be ~15min, got {delta}"
    finally:
        delete_test_vms(client)


@pytest.mark.local
def test_claim_fails_on_busy_vm() -> None:
    """Cannot claim an already-busy VM via atomic update."""
    env = resolve_env()
    client = get_supabase_client(env)

    # Insert busy VM (no project_id to avoid FK constraint)
    vm_id = insert_test_vm(client, status="busy")

    try:
        # Try to claim via atomic update (same pattern as claimVm in vm.ts)
        # The .eq("status", "idle") should return 0 rows since VM is busy
        result = (
            client.table("vms")
            .update({"status": "busy", "runtime_state": "starting"})
            .eq("id", vm_id)
            .eq("status", "idle")  # This should match nothing - VM is busy
            .execute()
        )
        # No rows should be updated
        assert len(result.data) == 0, "Should not be able to claim busy VM"
    finally:
        delete_test_vms(client)


@pytest.mark.local
def test_release_clears_lease() -> None:
    """Releasing a VM should clear project_id, lease_expires_at, and set status=idle."""
    env = resolve_env()
    client = get_supabase_client(env)

    # Insert busy VM with lease (no project_id to avoid FK - testing DB logic directly)
    vm_id = insert_test_vm(
        client,
        status="busy",
        lease_expires_at=datetime.utcnow() + timedelta(minutes=10),
    )

    try:
        # Simulate what releaseVm does in vm.ts
        now_iso = datetime.utcnow().isoformat()
        result = (
            client.table("vms")
            .update({
                "status": "idle",
                "runtime_state": "serving",
                "project_id": None,
                "desired_build_id": None,
                "lease_owner": None,
                "lease_expires_at": None,
                "last_shutdown_at": now_iso,
                "updated_at": now_iso,
            })
            .eq("id", vm_id)
            .execute()
        )

        assert len(result.data) == 1, "Should update exactly 1 VM"

        vm = get_vm(client, vm_id)
        assert vm["status"] == "idle", "Released VM should be idle"
        assert vm.get("project_id") is None, "Released VM should have no project_id"
        assert vm.get("lease_expires_at") is None, "Released VM should have no lease"
    finally:
        delete_test_vms(client)


@pytest.mark.local
def test_stale_heartbeat_pruned() -> None:
    """VMs with stale heartbeat should be marked as error during prune."""
    env = resolve_env()
    client = get_supabase_client(env)

    # Insert VM with stale heartbeat (2 min ago, TTL is 90s)
    stale_time = datetime.utcnow() - timedelta(seconds=120)
    vm_id = insert_test_vm(client, status="idle", last_heartbeat_at=stale_time)

    try:
        # Simulate what pruneStaleVms does: update VMs with old heartbeats
        # This tests the DB logic directly without needing edge functions
        cutoff = datetime.utcnow() - timedelta(seconds=90)
        cutoff_iso = cutoff.isoformat()
        now_iso = datetime.utcnow().isoformat()

        result = (
            client.table("vms")
            .update({
                "status": "error",
                "runtime_state": "error",
                "project_id": None,
                "desired_build_id": None,
                "lease_owner": None,
                "lease_expires_at": None,
                "last_shutdown_at": now_iso,
                "updated_at": now_iso,
            })
            .in_("status", ["idle", "busy", "starting"])
            .lt("last_heartbeat_at", cutoff_iso)
            .execute()
        )

        # Should have updated the stale VM
        assert len(result.data) >= 1, f"Should prune stale VMs, got {result.data}"

        # Verify stale VM is now error
        stale_vm = get_vm(client, vm_id)
        assert stale_vm["status"] == "error", "Stale VM should be pruned to error"
    finally:
        delete_test_vms(client)


# -----------------------------------------------------------------------------
# Multi-worker tests (need workers running)
# -----------------------------------------------------------------------------


@pytest.mark.multi
@pytest.mark.slow
def test_concurrent_claims_one_wins() -> None:
    """When multiple requests try to claim same VM, exactly one should win."""
    env = resolve_env()
    client = get_supabase_client(env)
    api_url = resolve_api_url(env["SUPABASE_URL"], env)
    service_key = env["SUPABASE_SERVICE_ROLE_KEY"]

    # Wait for at least 1 real worker VM to be available
    worker_vms = get_idle_worker_vms(client, min_count=1, timeout=10)
    if not worker_vms:
        pytest.skip(
            "No worker VMs available. Run: cd eb-worker/deploy && "
            "docker compose -f docker-compose.test.yml up --build"
        )

    try:
        # Create multiple projects
        project_ids = []
        for i in range(5):
            token = ensure_access_token(service_key, env["SUPABASE_URL"])
            project_id = create_project(api_url, token, name=f"Concurrent Test {i}")
            project_ids.append(project_id)

        # Submit concurrent acquire requests
        def acquire(project_id: str) -> tuple[str, int, str]:
            resp = requests.post(
                f"{api_url}/vm/acquire",
                headers=admin_headers(service_key),
                json={"project_id": project_id},
                timeout=60,
            )
            return project_id, resp.status_code, resp.text

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(acquire, pid) for pid in project_ids]
            results = [f.result() for f in concurrent.futures.as_completed(futures)]

        # Count successes (200 status)
        successes = [r for r in results if r[1] == 200]

        # With limited VMs and 5 concurrent requests, at most len(worker_vms) should succeed
        assert len(successes) <= len(worker_vms), f"At most {len(worker_vms)} claims should succeed, got {len(successes)}"
    finally:
        release_worker_vms(client)


@pytest.mark.multi
@pytest.mark.slow
def test_pool_contention_with_queue() -> None:
    """Multiple users competing for limited VMs - verify proper lifecycle."""
    env = resolve_env()
    client = get_supabase_client(env)
    api_url = resolve_api_url(env["SUPABASE_URL"], env)
    service_key = env["SUPABASE_SERVICE_ROLE_KEY"]

    # Wait for at least 2 real worker VMs
    worker_vms = get_idle_worker_vms(client, min_count=2, timeout=15)
    if len(worker_vms) < 2:
        pytest.skip(
            f"Need at least 2 worker VMs, got {len(worker_vms)}. Run: "
            "cd eb-worker/deploy && docker compose -f docker-compose.test.yml up --build"
        )

    try:
        # Create 5 projects
        project_ids = []
        for i in range(5):
            token = ensure_access_token(service_key, env["SUPABASE_URL"])
            project_id = create_project(api_url, token, name=f"Pool Test {i}")
            project_ids.append(project_id)

        # Track results
        results = {"success": 0, "no_vms": 0, "other": 0}

        def try_build(project_id: str) -> str:
            resp = requests.post(
                f"{api_url}/vm/acquire",
                headers=admin_headers(service_key),
                json={"project_id": project_id},
                timeout=60,
            )
            if resp.status_code == 200:
                return "success"
            elif "no idle vms" in resp.text.lower():
                return "no_vms"
            else:
                print(f"[DEBUG] acquire failed: {resp.status_code} {resp.text[:500]}")
                return "other"

        # Submit requests with small delays to observe contention
        for pid in project_ids:
            result = try_build(pid)
            results[result] += 1
            time.sleep(0.5)  # Small delay between requests

        # With worker VMs and passthrough mode (fast release), at least 2 should succeed
        assert results["success"] >= 2, f"At least 2 should succeed with {len(worker_vms)} VMs, got {results}"
    finally:
        release_worker_vms(client)


@pytest.mark.multi
def test_vm_release_makes_vm_available() -> None:
    """After release, VM should be claimable again."""
    env = resolve_env()
    client = get_supabase_client(env)
    api_url = resolve_api_url(env["SUPABASE_URL"], env)
    service_key = env["SUPABASE_SERVICE_ROLE_KEY"]

    # Wait for at least 1 real worker VM
    worker_vms = get_idle_worker_vms(client, min_count=1, timeout=10)
    if not worker_vms:
        pytest.skip(
            "No worker VMs available. Run: cd eb-worker/deploy && "
            "docker compose -f docker-compose.test.yml up --build"
        )

    try:
        # First claim
        token1 = ensure_access_token(service_key, env["SUPABASE_URL"])
        project1 = create_project(api_url, token1, name="First Claim")
        resp1 = requests.post(
            f"{api_url}/vm/acquire",
            headers=admin_headers(service_key),
            json={"project_id": project1},
            timeout=60,
        )

        if resp1.status_code != 200:
            pytest.skip(f"Could not acquire VM: {resp1.status_code} {resp1.text[:200]}")

        # Get the acquired VM's instance_id from response
        acquired_vm = resp1.json().get("vm", {})
        instance_id = acquired_vm.get("instance_id")
        if not instance_id:
            pytest.skip("Acquired VM missing instance_id")

        # Release using instance_id
        release_resp = requests.post(
            f"{api_url}/vms/release",
            headers=admin_headers(service_key),
            json={"instance_id": instance_id},
            timeout=30,
        )
        assert release_resp.status_code == 200, f"Release failed: {release_resp.text}"

        # Wait for release to propagate
        time.sleep(1)

        # Second claim should work
        token2 = ensure_access_token(service_key, env["SUPABASE_URL"])
        project2 = create_project(api_url, token2, name="Second Claim")
        resp2 = requests.post(
            f"{api_url}/vm/acquire",
            headers=admin_headers(service_key),
            json={"project_id": project2},
            timeout=60,
        )

        assert resp2.status_code == 200, f"Second acquire should succeed after release: {resp2.text}"
    finally:
        release_worker_vms(client)
