"""
Full app lifecycle E2E test:
1. Create user (via auth/v1/signup) - handled by fixture
2. Create project (POST /projects) - handled by fixture
3. Enable backend (PATCH /projects/{id})
4. Enable services via attachments
5. Send prompt with services + backend (POST /chat)
6. VM acquired (via startVm flow)
7. Build completes (poll /builds/{id})
8. Preview served (GET /preview/{projectId}/{version}/)
9. Share preview (PATCH /projects/{id} with is_public=true)
10. Verify public accessibility
"""
from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import urljoin

import pytest
import requests

from test.utils import admin_headers, auth_headers


# Test configuration
BUILD_TIMEOUT_SEC = 900  # 15 minutes for agent execution
BUILD_POLL_INTERVAL_SEC = 10


def poll_build(api_url: str, build_id: str, token: str, timeout_s: int = BUILD_TIMEOUT_SEC) -> dict[str, Any]:
    """Poll build status until completion or timeout."""
    deadline = time.time() + timeout_s
    last_payload: dict[str, Any] | None = None
    while time.time() < deadline:
        resp = requests.get(
            f"{api_url}/builds/{build_id}",
            headers=auth_headers(token),
            timeout=20,
        )
        if resp.status_code == 200:
            last_payload = resp.json()
            status = last_payload.get("status")
            print(f"[build] id={build_id[:12]}... status={status}")
            if status in {"succeeded", "failed"}:
                return last_payload
        time.sleep(BUILD_POLL_INTERVAL_SEC)
    raise TimeoutError(f"Build did not complete within {timeout_s}s: {json.dumps(last_payload)}")


def verify_preview_accessible(preview_url: str, token: str | None = None) -> bool:
    """Check if preview URL is accessible."""
    try:
        headers = auth_headers(token) if token else None
        resp = requests.get(preview_url, headers=headers, timeout=30, allow_redirects=True)
        if resp.status_code == 200:
            content_type = resp.headers.get("Content-Type", "")
            return "text/html" in content_type
        # Try with /index.html suffix
        if not preview_url.rstrip("/").endswith(".html"):
            alt_url = urljoin(preview_url.rstrip("/") + "/", "index.html")
            resp = requests.get(alt_url, headers=headers, timeout=30, allow_redirects=True)
            return resp.status_code == 200 and "text/html" in resp.headers.get("Content-Type", "")
    except Exception as e:
        print(f"[preview] access error: {e}")
    return False


@pytest.mark.integration
@pytest.mark.e2e
def test_full_app_lifecycle(
    supabase_url: str,
    api_url: str,
    anon_key: str,
    service_key: str,
    test_user: dict[str, Any],
    test_project: str,
) -> None:
    """
    Complete E2E test: user -> project -> prompt -> build -> preview -> share.
    """
    project_id = test_project
    user_token = test_user["token"]
    user_id = test_user["userId"]

    print(f"[e2e] Starting full lifecycle test")
    print(f"[e2e] User: {user_id[:8]}...")
    print(f"[e2e] Project: {project_id}")

    # Step 1: Enable backend on project
    print("[e2e] Step 1: Enabling backend...")
    backend_resp = requests.patch(
        f"{api_url}/projects/{project_id}",
        json={"backend_enabled": True},
        headers=auth_headers(user_token),
        timeout=20,
    )
    assert backend_resp.status_code == 200, f"Backend enable failed: {backend_resp.text}"

    # Verify backend was enabled
    project_resp = requests.get(
        f"{api_url}/projects/{project_id}",
        headers=auth_headers(user_token),
        timeout=20,
    )
    assert project_resp.status_code == 200
    project_data = project_resp.json()
    assert project_data.get("backend_enabled") is True, "Backend not enabled"
    assert project_data.get("backend_app_id"), "Backend app ID not created"
    print(f"[e2e] Backend enabled with app_id: {project_data.get('backend_app_id')[:8]}...")

    # Step 2: Send prompt with services and backend attachments
    print("[e2e] Step 2: Sending prompt with services/backend...")

    # TODO: we'll want to have something like this soon + lots of attachments.
    # # The "big ol' prompt" - complex enough to exercise services and backend
    # prompt = """
    # Build a task management app with the following features:
    # - A list of tasks with title, description, and due date
    # - Ability to mark tasks as complete
    # - Store tasks in the backend database
    # - Generate task summaries using AI text services
    # - Beautiful modern UI with animations
    # """
    prompt = "Build an super basic AI chat page for cooking recipes"

    chat_payload = {
        "project_id": project_id,
        "message": prompt,
        "model": "claude-sonnet-4-5",
        "attachments": {
            "services": [
                {"stub": "openai-gpt-4o-mini"},  # Text service
            ],
            "backend": True,
        },
    }

    chat_resp = requests.post(
        f"{api_url}/chat",
        json=chat_payload,
        headers=auth_headers(user_token),
        timeout=30,
    )
    assert chat_resp.status_code == 200, f"Chat failed: {chat_resp.text}"

    chat_data = chat_resp.json()
    print(f"[e2e] Chat response keys: {list(chat_data.keys())}")

    assert chat_data.get("ok") is True, f"Chat not ok: {chat_data}"
    assert not chat_data.get("staged"), "Build was staged instead of starting"

    # Step 3: Verify VM was acquired (or job for worker flow)
    print("[e2e] Step 3: Verifying VM/job acquisition...")
    vm_data = chat_data.get("vm")
    job_data = chat_data.get("job")
    if vm_data:
        print(f"[e2e] VM acquired: mode={vm_data.get('mode')}")
    elif job_data:
        print(f"[e2e] Using worker flow (job_id: {job_data.get('job_id', 'unknown')[:12]}...)")
    else:
        pytest.fail("Chat response missing both vm and job - build not started")

    # Step 4: Poll for build completion
    print("[e2e] Step 4: Polling for build completion...")
    build_data = chat_data.get("build", {})
    build_id = build_data.get("id")
    assert build_id, "Build ID missing from chat response"
    print(f"[e2e] Build ID: {build_id}")

    final_build = poll_build(api_url, build_id, user_token)
    assert final_build.get("status") == "succeeded", f"Build failed: {final_build}"
    print(f"[e2e] Build succeeded")

    # Step 5: Verify preview is accessible
    print("[e2e] Step 5: Verifying preview accessibility...")
    artifacts = final_build.get("artifacts") or {}
    preview_url = artifacts.get("web")
    assert preview_url, f"Preview URL missing from build artifacts: {final_build}"
    api_preview_url = f"{api_url}/preview/{build_id}/"
    print(f"[e2e] Preview URL: {api_preview_url}")

    # Preview should be accessible (project owner can access)
    preview_accessible = verify_preview_accessible(api_preview_url, user_token)
    assert preview_accessible, f"Preview not accessible: {api_preview_url}"
    print("[e2e] Preview is accessible")

    # Step 6: Get version number for preview path test
    version_id = final_build.get("version_id") or final_build.get("version_number")
    if version_id:
        api_preview_url = f"{api_url}/preview/{project_id}/{version_id}/"
        print(f"[e2e] Testing API preview route: {api_preview_url}")
        api_preview_resp = requests.get(
            api_preview_url,
            headers=auth_headers(user_token),
            timeout=30,
            allow_redirects=True,
        )
        # May return 200 with shell or redirect
        assert api_preview_resp.status_code in (200, 302, 307), f"API preview failed: {api_preview_resp.status_code}"

    # Step 7: Share preview (set is_public=true)
    print("[e2e] Step 7: Sharing preview (setting is_public=true)...")
    share_resp = requests.patch(
        f"{api_url}/projects/{project_id}",
        json={"is_public": True},
        headers=auth_headers(user_token),
        timeout=20,
    )
    assert share_resp.status_code == 200, f"Share failed: {share_resp.text}"

    # Verify project is now public
    project_check = requests.get(
        f"{api_url}/projects/{project_id}",
        headers=auth_headers(user_token),
        timeout=20,
    )
    assert project_check.status_code == 200
    assert project_check.json().get("is_public") is True, "Project not marked as public"
    print("[e2e] Project is now public")

    # Step 8: Verify preview requires auth
    print("[e2e] Step 8: Verifying preview requires auth...")
    unauth_resp = requests.get(api_preview_url, timeout=30, allow_redirects=True)
    assert unauth_resp.status_code in (401, 403), f"Preview should require auth: {unauth_resp.status_code}"

    print("[e2e] FULL LIFECYCLE TEST PASSED")


@pytest.mark.integration
@pytest.mark.e2e
def test_simple_build_preview(
    supabase_url: str,
    api_url: str,
    anon_key: str,
    service_key: str,
    test_user: dict[str, Any],
    test_project: str,
) -> None:
    """
    Simpler test: project -> prompt -> build -> preview (no backend/services).
    Faster execution for basic validation.
    """
    project_id = test_project
    user_token = test_user["token"]

    print(f"[e2e-simple] Starting simple build test")
    print(f"[e2e-simple] Project: {project_id}")

    # Send a simple prompt
    chat_payload = {
        "project_id": project_id,
        "message": "Build a simple hello world app with a greeting message.",
        "model": "claude-sonnet-4-5",
    }

    chat_resp = requests.post(
        f"{api_url}/chat",
        json=chat_payload,
        headers=auth_headers(user_token),
        timeout=30,
    )
    assert chat_resp.status_code == 200, f"Chat failed: {chat_resp.text}"

    chat_data = chat_resp.json()
    assert chat_data.get("ok") is True, f"Chat not ok: {chat_data}"

    build_id = (chat_data.get("build") or {}).get("id")
    assert build_id, "Build ID missing"
    print(f"[e2e-simple] Build started: {build_id[:12]}...")

    # Poll for completion (shorter timeout for simple prompt)
    final_build = poll_build(api_url, build_id, user_token, timeout_s=600)
    assert final_build.get("status") == "succeeded", f"Build failed: {final_build}"

    preview_url = f"{api_url}/preview/{build_id}/"
    assert verify_preview_accessible(preview_url, user_token), f"Preview not accessible: {preview_url}"

    print("[e2e-simple] SIMPLE BUILD TEST PASSED")
