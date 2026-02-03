"""
Integration tests for admin leaderboard endpoints.

Tests:
- GET /admin/leaderboard - List builds with usage metrics
- PATCH /admin/leaderboard/{buildId}/scores - Update build scores
"""
from __future__ import annotations

import pytest
import requests

from test.utils import (
    admin_headers,
    resolve_api_url,
    resolve_env,
)


def build_urls(env: dict[str, str]) -> str:
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is required for integration tests.")
    return resolve_api_url(supabase_url, env)


@pytest.mark.integration
def test_leaderboard_list() -> None:
    """Test GET /admin/leaderboard returns builds list."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set; cannot run integration flow.")

    api_url = build_urls(env)
    headers = admin_headers(service_key)

    # Fetch leaderboard
    resp = requests.get(
        f"{api_url}/admin/leaderboard",
        headers=headers,
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()

    # Verify response structure
    assert "builds" in data, "response should have 'builds' key"
    assert "total" in data, "response should have 'total' key"
    assert isinstance(data["builds"], list), "'builds' should be a list"
    assert isinstance(data["total"], int), "'total' should be an integer"


@pytest.mark.integration
def test_leaderboard_filters() -> None:
    """Test GET /admin/leaderboard with filters."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set; cannot run integration flow.")

    api_url = build_urls(env)
    headers = admin_headers(service_key)

    # Fetch with agent_version filter
    resp = requests.get(
        f"{api_url}/admin/leaderboard?agent_version=sonic_2e&limit=10",
        headers=headers,
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "builds" in data

    # Fetch with model filter
    resp = requests.get(
        f"{api_url}/admin/leaderboard?model=claude-sonnet-4-5&limit=5",
        headers=headers,
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "builds" in data


@pytest.mark.integration
def test_leaderboard_pagination() -> None:
    """Test GET /admin/leaderboard pagination."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set; cannot run integration flow.")

    api_url = build_urls(env)
    headers = admin_headers(service_key)

    # Fetch first page
    resp = requests.get(
        f"{api_url}/admin/leaderboard?limit=5&offset=0",
        headers=headers,
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    page1 = resp.json()
    assert len(page1["builds"]) <= 5

    # Fetch second page
    resp = requests.get(
        f"{api_url}/admin/leaderboard?limit=5&offset=5",
        headers=headers,
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    page2 = resp.json()

    # If there are builds, pages should be different (unless total < 5)
    if page1["total"] > 5 and len(page1["builds"]) > 0 and len(page2["builds"]) > 0:
        assert page1["builds"][0]["id"] != page2["builds"][0]["id"], "pagination should return different builds"


@pytest.mark.integration
def test_update_build_scores() -> None:
    """Test PATCH /admin/leaderboard/{buildId}/scores updates scores."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set; cannot run integration flow.")

    api_url = build_urls(env)
    headers = admin_headers(service_key)

    # First get a build to score
    resp = requests.get(
        f"{api_url}/admin/leaderboard?limit=1",
        headers=headers,
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()

    if not data["builds"]:
        pytest.skip("No builds available to test score update")

    build_id = data["builds"][0]["id"]

    # Update scores
    scores = {"design": 4, "functionality": 5, "polish": 3}
    resp = requests.patch(
        f"{api_url}/admin/leaderboard/{build_id}/scores",
        headers=headers,
        json={"scores": scores},
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert result.get("build") is not None, "score update should return updated build"

    # Verify scores were saved by fetching the build again
    resp = requests.get(
        f"{api_url}/admin/leaderboard?limit=100",
        headers=headers,
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    updated_build = next((b for b in data["builds"] if b["id"] == build_id), None)
    if updated_build:
        assert updated_build.get("scores", {}).get("design") == 4
        assert updated_build.get("scores", {}).get("functionality") == 5
        assert updated_build.get("scores", {}).get("polish") == 3


@pytest.mark.integration
def test_update_build_scores_validation() -> None:
    """Test PATCH /admin/leaderboard/{buildId}/scores validates score values."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set; cannot run integration flow.")

    api_url = build_urls(env)
    headers = admin_headers(service_key)

    # First get a build
    resp = requests.get(
        f"{api_url}/admin/leaderboard?limit=1",
        headers=headers,
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()

    if not data["builds"]:
        pytest.skip("No builds available to test score validation")

    build_id = data["builds"][0]["id"]

    # Try invalid score (out of range)
    resp = requests.patch(
        f"{api_url}/admin/leaderboard/{build_id}/scores",
        headers=headers,
        json={"scores": {"design": 10}},  # Invalid: should be 1-5
        timeout=15,
    )
    assert resp.status_code == 400, f"Expected 400 for invalid score, got {resp.status_code}: {resp.text}"

    # Try invalid score (negative)
    resp = requests.patch(
        f"{api_url}/admin/leaderboard/{build_id}/scores",
        headers=headers,
        json={"scores": {"functionality": -1}},
        timeout=15,
    )
    assert resp.status_code == 400, f"Expected 400 for negative score, got {resp.status_code}: {resp.text}"


@pytest.mark.integration
def test_leaderboard_requires_admin() -> None:
    """Test that leaderboard endpoints require admin access."""
    env = resolve_env()
    api_url = build_urls(env)

    # Try without auth
    resp = requests.get(
        f"{api_url}/admin/leaderboard",
        timeout=15,
    )
    assert resp.status_code in (401, 403), f"Expected 401/403 without auth, got {resp.status_code}"
