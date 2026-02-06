"""
Privacy plan enforcement tests.

Covers:
- Free users cannot create private projects.
"""
from __future__ import annotations

import pytest
import requests

from test.utils import auth_headers, ensure_access_token, resolve_api_url, resolve_env


@pytest.mark.local
@pytest.mark.integration
def test_free_user_cannot_create_private_project() -> None:
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not service_key or not supabase_url:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/projects",
        headers=headers,
        json={"name": "Private Project", "is_public": False},
        timeout=20,
    )

    assert resp.status_code == 403, resp.text
    payload = resp.json()
    assert payload.get("error") == "private_project_requires_plan"
