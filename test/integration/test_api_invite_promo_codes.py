"""
Integration tests for invite and promo code flows.
"""
from __future__ import annotations

import pytest
import requests

from test.utils import (
    admin_headers,
    auth_headers,
    ensure_access_token,
    resolve_api_url,
    resolve_auth_url,
    resolve_env,
)


def build_urls(env: dict[str, str]) -> tuple[str, str]:
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is required for integration tests.")
    api_url = resolve_api_url(supabase_url, env)
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

    admin_headers_map = admin_headers(service_key)
    invite_resp = requests.post(
        f"{api_url}/admin/invites",
        headers=admin_headers_map,
        json={},
        timeout=15,
    )
    assert invite_resp.status_code == 200, invite_resp.text
    invite_data = invite_resp.json()
    code = invite_data.get("code")
    assert code, "admin invite did not return a code"

    user_headers = auth_headers(access_token)
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

    admin_headers_map = admin_headers(service_key)
    promo_resp = requests.post(
        f"{api_url}/admin/promo-codes",
        headers=admin_headers_map,
        json={"amount": 5},
        timeout=15,
    )
    assert promo_resp.status_code == 200, promo_resp.text
    promo_data = promo_resp.json()
    code = promo_data.get("code")
    assert code, "admin promo did not return a code"

    user_headers = auth_headers(access_token)
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
