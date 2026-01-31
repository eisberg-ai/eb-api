"""
Production integration flow: project -> chat -> build -> preview.
"""
from __future__ import annotations

import json
import time
import uuid
from urllib.parse import urljoin

import pytest
import requests

from test.utils import (
    ensure_access_token,
    ensure_credit_balance,
    resolve_api_url,
    resolve_env,
)


def poll_build(api_url: str, build_id: str, timeout_s: int = 900) -> dict:
    deadline = time.time() + timeout_s
    last_payload: dict | None = None
    while time.time() < deadline:
        resp = requests.get(f"{api_url}/builds/{build_id}", timeout=20)
        if resp.status_code == 200:
            last_payload = resp.json()
            status = last_payload.get("status")
            print(f"[build] id={build_id} status={status}")
            if status in {"succeeded", "failed"}:
                return last_payload
        time.sleep(5)
    raise TimeoutError(f"build did not complete within {timeout_s}s: {json.dumps(last_payload)}")


@pytest.mark.integration
def test_chat_builds_and_previews() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    project_id = f"project-preview-{uuid.uuid4().hex[:8]}"
    project_payload = {"id": project_id, "name": "Prod Preview Test", "model": "claude-sonnet-4-5"}
    project_resp = requests.post(
        f"{api_url}/projects",
        json=project_payload,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20,
    )
    assert project_resp.status_code == 200, project_resp.text
    print(f"[project] created {project_id}")

    chat_payload = {
        "project_id": project_id,
        "message": "Build a simple to-do app.",
        "model": "claude-sonnet-4-5",
    }
    chat_resp = requests.post(
        f"{api_url}/chat",
        json=chat_payload,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20,
    )
    assert chat_resp.status_code == 200, chat_resp.text
    chat_data = chat_resp.json()
    print(f"[chat] response {chat_data}")
    assert chat_data.get("ok") is True, chat_data
    assert not chat_data.get("staged"), chat_data
    if chat_data.get("job"):
        pytest.fail("chat response returned job; prod API is still on worker flow, not Cloud Run VM flow.")
    if not chat_data.get("vm"):
        pytest.fail("chat response missing vm; Cloud Run start not wired in prod.")
    build_id = (chat_data.get("build") or {}).get("id")
    assert build_id, "chat response missing build id"
    print(f"[build] created {build_id}")

    build_status = poll_build(api_url, build_id)
    print(f"[build] final {build_status.get('status')}")
    assert build_status.get("status") == "succeeded", build_status
    preview_url = (build_status.get("artifacts") or {}).get("web")
    assert preview_url, f"missing preview url in build artifacts: {build_status}"
    assert "localhost" not in preview_url, f"preview url is not public: {preview_url}"

    preview_resp = requests.get(preview_url, timeout=20, allow_redirects=True)
    if preview_resp.status_code == 404:
        preview_resp = requests.get(urljoin(preview_url.rstrip("/") + "/", "home"), timeout=20)
    print(f"[preview] url={preview_resp.url} status={preview_resp.status_code}")
    assert preview_resp.status_code == 200, preview_resp.text
    assert "text/html" in preview_resp.headers.get("Content-Type", "")
