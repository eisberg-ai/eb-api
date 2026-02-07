"""
Cloud tests for VM assignment.

These tests require cloud infrastructure (GCE VMs, VM pool).

Run with: pytest -m cloud --env staging
"""
from __future__ import annotations

import pytest
import requests

from test.utils import (
    admin_headers,
    create_project,
    ensure_access_token,
    resolve_api_url,
    resolve_env,
)


@pytest.mark.cloud
@pytest.mark.slow
def test_vm_acquire_and_release() -> None:
    """Test acquiring and releasing a VM via the API."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    supabase_url = env.get("SUPABASE_URL")
    if not service_key or not supabase_url:
        pytest.skip("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    project_id = create_project(api_url, access_token)

    # Acquire VM
    acquire_resp = requests.post(
        f"{api_url}/vm/acquire",
        headers=admin_headers(service_key),
        json={"project_id": project_id},
        timeout=60,
    )
    assert acquire_resp.status_code == 200, f"Failed to acquire VM: {acquire_resp.text}"
    vm_data = acquire_resp.json()
    assert "vm_id" in vm_data or "instance_id" in vm_data, "VM response should include VM ID"

    vm_id = vm_data.get("vm_id") or vm_data.get("instance_id")

    # Release VM
    release_resp = requests.post(
        f"{api_url}/vm/release",
        headers=admin_headers(service_key),
        json={"vm_id": vm_id, "project_id": project_id},
        timeout=30,
    )
    assert release_resp.status_code == 200, f"Failed to release VM: {release_resp.text}"


@pytest.mark.cloud
def test_vm_pool_status() -> None:
    """Test fetching VM pool status."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    supabase_url = env.get("SUPABASE_URL")
    if not service_key or not supabase_url:
        pytest.skip("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    api_url = resolve_api_url(supabase_url, env)

    resp = requests.get(
        f"{api_url}/admin/cluster",
        headers=admin_headers(service_key),
        timeout=30,
    )
    assert resp.status_code == 200, f"Failed to get cluster status: {resp.text}"
    data = resp.json()
    assert "rows" in data or "vms" in data, "Response should include VM list"
