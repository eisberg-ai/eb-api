"""
Integration tests for the app name generation endpoint.

Covers:
- POST /generate-app-names (generate 5 iconic app names)
- Authentication requirements
- Input validation
"""
from __future__ import annotations

import pytest
import requests

from test.utils import (
    auth_headers,
    ensure_access_token,
    resolve_api_url,
    resolve_env,
)


def _build_api_url(env: dict[str, str]) -> str:
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is required for integration tests.")
    return resolve_api_url(supabase_url, env)


@pytest.mark.local
@pytest.mark.integration
def test_generate_app_names_success() -> None:
    """Should generate 5 unique app names for a valid description."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/generate-app-names",
        headers=headers,
        json={"description": "A fitness app that tracks workouts and shows progress over time"},
        timeout=30,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()

    # Should return a list of names
    assert "names" in data
    assert isinstance(data["names"], list)
    assert len(data["names"]) >= 1  # At least one name
    assert len(data["names"]) <= 5  # At most 5 names

    # Each name should be a non-empty string
    for name in data["names"]:
        assert isinstance(name, str)
        assert len(name) > 0
        assert len(name) < 30  # Names should be reasonably short


@pytest.mark.local
@pytest.mark.integration
def test_generate_app_names_different_descriptions() -> None:
    """Different descriptions should potentially generate different names."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    # Generate names for a fitness app
    resp1 = requests.post(
        f"{api_url}/generate-app-names",
        headers=headers,
        json={"description": "A meditation and mindfulness app with guided sessions"},
        timeout=30,
    )
    assert resp1.status_code == 200, resp1.text
    names1 = resp1.json()["names"]

    # Generate names for a cooking app
    resp2 = requests.post(
        f"{api_url}/generate-app-names",
        headers=headers,
        json={"description": "A recipe sharing app for home cooks"},
        timeout=30,
    )
    assert resp2.status_code == 200, resp2.text
    names2 = resp2.json()["names"]

    # Both should have valid results
    assert len(names1) >= 1
    assert len(names2) >= 1


@pytest.mark.local
@pytest.mark.integration
def test_generate_app_names_requires_description() -> None:
    """Should return 400 if description is missing."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    # Missing description
    resp = requests.post(
        f"{api_url}/generate-app-names",
        headers=headers,
        json={},
        timeout=15,
    )
    assert resp.status_code == 400, resp.text
    assert "description" in resp.json().get("error", "").lower()


@pytest.mark.local
@pytest.mark.integration
def test_generate_app_names_empty_description() -> None:
    """Should return 400 if description is empty."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    # Empty string description
    resp = requests.post(
        f"{api_url}/generate-app-names",
        headers=headers,
        json={"description": ""},
        timeout=15,
    )
    assert resp.status_code == 400, resp.text

    # Whitespace-only description
    resp2 = requests.post(
        f"{api_url}/generate-app-names",
        headers=headers,
        json={"description": "   "},
        timeout=15,
    )
    assert resp2.status_code == 400, resp2.text


@pytest.mark.local
@pytest.mark.integration
def test_generate_app_names_requires_auth() -> None:
    """Should reject unauthenticated requests."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        pytest.skip("SUPABASE_URL not set.")

    api_url = resolve_api_url(supabase_url, env)

    resp = requests.post(
        f"{api_url}/generate-app-names",
        json={"description": "A todo list app"},
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    assert resp.status_code == 401
