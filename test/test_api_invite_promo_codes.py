"""
Integration tests for invite and promo code flows.
"""
from __future__ import annotations

import os
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
def test_invite_code_redeem_flow() -> None:
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set; cannot run integration flow.")

    api_url, _auth_url = build_urls(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))

    admin_headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/json",
    }
    invite_resp = requests.post(
        f"{api_url}/admin/invites",
        headers=admin_headers,
        json={},
        timeout=15,
    )
    assert invite_resp.status_code == 200, invite_resp.text
    invite_data = invite_resp.json()
    code = invite_data.get("code")
    assert code, "admin invite did not return a code"

    user_headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    redeem_resp = requests.post(
        f"{api_url}/auth/invite",
        headers=user_headers,
        json={"code": code},
        timeout=15,
    )
    assert redeem_resp.status_code == 200, redeem_resp.text
    redeem_data = redeem_resp.json()
    assert redeem_data.get("ok") is True

    profile_resp = requests.get(
        f"{api_url}/users/profile",
        headers=user_headers,
        timeout=15,
    )
    assert profile_resp.status_code == 200, profile_resp.text
    profile = profile_resp.json()
    assert profile.get("joinMethod") == "invite"
    assert profile.get("joinCode") == code

    redeem_again = requests.post(
        f"{api_url}/auth/invite",
        headers=user_headers,
        json={"code": code},
        timeout=15,
    )
    assert redeem_again.status_code == 409, redeem_again.text
    assert redeem_again.json().get("error") == "invite_code_used"


@pytest.mark.integration
def test_promo_code_one_time_use() -> None:
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set; cannot run integration flow.")

    api_url, _auth_url = build_urls(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))

    admin_headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/json",
    }
    promo_resp = requests.post(
        f"{api_url}/admin/promo-codes",
        headers=admin_headers,
        json={"amount": 5},
        timeout=15,
    )
    assert promo_resp.status_code == 200, promo_resp.text
    promo_data = promo_resp.json()
    code = promo_data.get("code")
    assert code, "admin promo did not return a code"

    user_headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    redeem_resp = requests.post(
        f"{api_url}/billing/promo",
        headers=user_headers,
        json={"code": code},
        timeout=15,
    )
    assert redeem_resp.status_code == 200, redeem_resp.text
    redeem_data = redeem_resp.json()
    assert redeem_data.get("promo", {}).get("code") == code

    redeem_again = requests.post(
        f"{api_url}/billing/promo",
        headers=user_headers,
        json={"code": code},
        timeout=15,
    )
    assert redeem_again.status_code == 409, redeem_again.text
    assert redeem_again.json().get("error") == "promo_code_used"
