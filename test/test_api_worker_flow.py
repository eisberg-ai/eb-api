"""
Integration flow that mirrors web/mobile: sign up, post chat, verify VM start.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest
import requests

from test.worker.utils import ensure_access_token, load_env_file, resolve_api_url, resolve_auth_url


def resolve_env() -> dict[str, str]:
    env = dict(os.environ)
    if env.get("SUPABASE_URL") and env.get("SUPABASE_SERVICE_ROLE_KEY"):
        return env
    env_file = Path(__file__).resolve().parents[2] / "worker" / ".env.local"
    env.update(load_env_file(env_file))
    return env


def build_urls(env: dict[str, str]) -> tuple[str, str]:
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is required for integration tests.")
    api_url = env.get("API_URL") or resolve_api_url(supabase_url)
    auth_url = resolve_auth_url(supabase_url)
    return api_url, auth_url


@pytest.mark.integration
def test_chat_creates_vm_flow() -> None:
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set; cannot run integration flow.")

    api_url, auth_url = build_urls(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))

    project_id = f"project-flow-{uuid.uuid4().hex[:8]}"
    payload = {
        "project_id": project_id,
        "message": "Build a simple to-do app.",
        "model": "claude-sonnet-4-5",
    }
    chat_resp = requests.post(
        f"{api_url}/chat",
        json=payload,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    assert chat_resp.status_code == 200, chat_resp.text
    chat_data = chat_resp.json()
    assert chat_data.get("ok") is True, chat_data
    build_id = (chat_data.get("build") or {}).get("id")
    assert build_id, "chat response missing build id"
    vm = chat_data.get("vm") or {}
    assert vm.get("mode") == "building"

    vm_resp = requests.get(
        f"{api_url}/vms/{project_id}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    assert vm_resp.status_code == 200, vm_resp.text
    vm_data = vm_resp.json().get("vm", {})
    assert vm_data.get("mode") == "building"
