"""
Cloud tests for building apps on real VMs.

These tests require cloud infrastructure and take several minutes.

Run with: pytest -m cloud --env staging
"""
from __future__ import annotations

import time
import pytest
import requests

from test.utils import (
    admin_headers,
    auth_headers,
    create_project,
    ensure_access_token,
    resolve_api_url,
    resolve_env,
)


@pytest.mark.cloud
@pytest.mark.slow
def test_simple_build_on_cloud() -> None:
    """Test running a simple build on a real cloud VM."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    supabase_url = env.get("SUPABASE_URL")
    if not service_key or not supabase_url:
        pytest.skip("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)

    # Create project
    project_id = create_project(api_url, access_token, service_key, name="Cloud Test App")

    # Send a simple prompt
    chat_resp = requests.post(
        f"{api_url}/chat",
        headers=auth_headers(access_token),
        json={
            "project_id": project_id,
            "message": "Create a simple hello world app with a button that says 'Click me'",
        },
        timeout=30,
    )
    assert chat_resp.status_code == 200, f"Chat failed: {chat_resp.text}"
    chat_data = chat_resp.json()
    build_id = chat_data.get("build", {}).get("id")
    assert build_id, "Response should include build ID"

    # Poll for build completion (up to 10 minutes)
    max_wait = 600
    poll_interval = 10
    start_time = time.time()
    final_status = None

    while time.time() - start_time < max_wait:
        build_resp = requests.get(
            f"{api_url}/builds/{build_id}",
            headers=auth_headers(access_token),
            timeout=15,
        )
        if build_resp.status_code != 200:
            time.sleep(poll_interval)
            continue

        build_data = build_resp.json()
        status = build_data.get("status")
        if status in ("succeeded", "failed", "error"):
            final_status = status
            break

        time.sleep(poll_interval)

    assert final_status == "succeeded", f"Build did not succeed, status: {final_status}"


@pytest.mark.cloud
@pytest.mark.slow
def test_build_with_services() -> None:
    """Test building an app with attached services on cloud."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    supabase_url = env.get("SUPABASE_URL")
    if not service_key or not supabase_url:
        pytest.skip("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)

    # Create project
    project_id = create_project(api_url, access_token, service_key, name="Service Test App")

    # Enable a service
    enable_resp = requests.post(
        f"{api_url}/projects/{project_id}/services",
        headers=auth_headers(access_token),
        json={"serviceStub": "openai-gpt-4o-mini"},
        timeout=15,
    )
    # Service enablement may fail if not configured, that's ok for this test
    if enable_resp.status_code != 200:
        pytest.skip("Could not enable service - may not be configured in environment")

    # Send a prompt that uses the service
    chat_resp = requests.post(
        f"{api_url}/chat",
        headers=auth_headers(access_token),
        json={
            "project_id": project_id,
            "message": "Create an AI chat app that uses OpenAI to respond to messages",
            "attachments": {"services": [{"stub": "openai-gpt-4o-mini"}]},
        },
        timeout=30,
    )
    assert chat_resp.status_code == 200, f"Chat failed: {chat_resp.text}"
    chat_data = chat_resp.json()
    build_id = chat_data.get("build", {}).get("id")
    assert build_id, "Response should include build ID"

    # Poll for build completion (up to 15 minutes for service builds)
    max_wait = 900
    poll_interval = 15
    start_time = time.time()
    final_status = None

    while time.time() - start_time < max_wait:
        build_resp = requests.get(
            f"{api_url}/builds/{build_id}",
            headers=auth_headers(access_token),
            timeout=15,
        )
        if build_resp.status_code != 200:
            time.sleep(poll_interval)
            continue

        build_data = build_resp.json()
        status = build_data.get("status")
        if status in ("succeeded", "failed", "error"):
            final_status = status
            break

        time.sleep(poll_interval)

    assert final_status == "succeeded", f"Build did not succeed, status: {final_status}"
