"""
Local integration tests for preview share tokens.
"""
from __future__ import annotations

import uuid

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


@pytest.mark.local
@pytest.mark.integration
def test_preview_share_token_and_legacy_removal() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)

    project_id = create_project(api_url, access_token, name="Preview Share Test")
    build_id = f"build-{uuid.uuid4().hex[:8]}"
    build_payload = {
        "id": build_id,
        "project_id": project_id,
        "version_number": 1,
        "status": "succeeded",
        "artifacts": {"web": "https://example.com/"},
    }
    build_resp = requests.post(
        f"{api_url}/builds",
        json=build_payload,
        headers=admin_headers(service_key),
        timeout=20,
    )
    assert build_resp.status_code == 200, build_resp.text

    share_resp = requests.post(
        f"{api_url}/preview/share",
        json={"project_id": project_id, "build_id": build_id},
        headers=auth_headers(access_token),
        timeout=20,
    )
    assert share_resp.status_code == 200, share_resp.text
    payload = share_resp.json()
    assert payload.get("token"), payload
    assert payload.get("project_id") == project_id
    assert payload.get("build_id") == build_id

    legacy_resp = requests.get(
        f"{api_url}/preview/{project_id}/1",
        headers=auth_headers(access_token),
        timeout=20,
    )
    assert legacy_resp.status_code == 410, legacy_resp.text
