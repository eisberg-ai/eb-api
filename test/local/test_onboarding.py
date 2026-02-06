"""
Integration tests for the user onboarding flow.

Covers:
- GET /users/onboarding (check status)
- POST /users/onboarding (submit per-page progress)
- Full multi-step flow with completion
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
def test_onboarding_status_default() -> None:
    """New user should have onboarding not completed."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.get(f"{api_url}/users/onboarding", headers=headers, timeout=15)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["completed"] is False
    assert data["currentStep"] == 0
    assert data["answers"] == {}


@pytest.mark.local
@pytest.mark.integration
def test_onboarding_submit_single_step() -> None:
    """Submitting a single step should persist answers and step number."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    # submit step 1 with motivation answer
    submit_resp = requests.post(
        f"{api_url}/users/onboarding",
        headers=headers,
        json={
            "motivation": "fun",
            "currentStep": 1,
            "completed": False,
        },
        timeout=15,
    )
    assert submit_resp.status_code == 200, submit_resp.text
    assert submit_resp.json().get("ok") is True

    # verify it was saved
    status_resp = requests.get(f"{api_url}/users/onboarding", headers=headers, timeout=15)
    assert status_resp.status_code == 200, status_resp.text
    data = status_resp.json()
    assert data["completed"] is False
    assert data["currentStep"] == 1
    assert data["answers"]["motivation"] == "fun"


@pytest.mark.local
@pytest.mark.integration
def test_onboarding_submit_updates_previous() -> None:
    """Later submissions should update (not replace) the saved answers."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    # submit step 1
    first_resp = requests.post(
        f"{api_url}/users/onboarding",
        headers=headers,
        json={"motivation": "learning", "currentStep": 1},
        timeout=15,
    )
    assert first_resp.status_code == 200, first_resp.text

    # submit step 2 with additional data (partial update)
    second_resp = requests.post(
        f"{api_url}/users/onboarding",
        headers=headers,
        json={"goal": "social", "currentStep": 2},
        timeout=15,
    )
    assert second_resp.status_code == 200, second_resp.text

    # verify both answers are present
    status_resp = requests.get(f"{api_url}/users/onboarding", headers=headers, timeout=15)
    assert status_resp.status_code == 200, status_resp.text
    data = status_resp.json()
    assert data["currentStep"] == 2
    assert data["answers"]["motivation"] == "learning"
    assert data["answers"]["goal"] == "social"


@pytest.mark.local
@pytest.mark.integration
def test_onboarding_full_flow_completion() -> None:
    """Full onboarding flow: submit multiple steps, then mark as completed."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    steps = [
        {"referralCode": None, "currentStep": 1},
        {"referralCode": None, "motivation": "side_project", "currentStep": 2},
        {"referralCode": None, "motivation": "side_project", "goal": "productivity", "currentStep": 3},
        {"referralCode": None, "motivation": "side_project", "goal": "productivity", "progress": "idea", "currentStep": 4},
        {
            "referralCode": None,
            "motivation": "side_project",
            "goal": "productivity",
            "progress": "idea",
            "codingExperience": "beginner",
            "aiExperience": "tried",
            "appDescription": "A task manager",
            "appName": "TaskFlow",
            "rating": 5,
            "currentStep": 14,
            "completed": True,
        },
    ]

    for step_data in steps:
        resp = requests.post(
            f"{api_url}/users/onboarding",
            headers=headers,
            json=step_data,
            timeout=15,
        )
        assert resp.status_code == 200, resp.text

    # verify completed
    status_resp = requests.get(f"{api_url}/users/onboarding", headers=headers, timeout=15)
    assert status_resp.status_code == 200, status_resp.text
    data = status_resp.json()
    assert data["completed"] is True
    assert data["answers"]["motivation"] == "side_project"
    assert data["answers"]["goal"] == "productivity"
    assert data["answers"]["appName"] == "TaskFlow"
    assert data["answers"]["rating"] == 5


@pytest.mark.local
@pytest.mark.integration
def test_onboarding_requires_auth() -> None:
    """Onboarding endpoints should reject unauthenticated requests."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        pytest.skip("SUPABASE_URL not set.")

    api_url = resolve_api_url(supabase_url, env)

    get_resp = requests.get(f"{api_url}/users/onboarding", timeout=15)
    assert get_resp.status_code == 401

    post_resp = requests.post(
        f"{api_url}/users/onboarding",
        json={"motivation": "fun", "currentStep": 1},
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    assert post_resp.status_code == 401
