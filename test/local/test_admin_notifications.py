"""
Admin notification broadcast tests.
"""
from __future__ import annotations

import base64
import json
import uuid

import pytest
import requests

from test.utils import (
    admin_headers,
    auth_headers,
    ensure_access_token,
    ensure_credit_balance,
    resolve_api_url,
    resolve_env,
)


def decode_jwt_sub(token: str) -> str:
    parts = token.split(".")
    if len(parts) < 2:
        raise ValueError("invalid_jwt")
    payload = parts[1]
    padded = payload + "=" * (-len(payload) % 4)
    raw = base64.urlsafe_b64decode(padded)
    data = json.loads(raw.decode("utf-8"))
    return str(data.get("sub") or "")


def ensure_user_profile_row(supabase_url: str, service_key: str, user_id: str) -> None:
    resp = requests.post(
        f"{supabase_url}/rest/v1/user_profiles",
        headers={
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=representation",
        },
        json={"user_id": user_id},
        timeout=20,
    )
    assert resp.status_code in (200, 201), resp.text


@pytest.mark.local
@pytest.mark.integration
def test_admin_broadcast_notification_reaches_user() -> None:
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not service_key or not supabase_url:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    user_id = decode_jwt_sub(access_token)
    assert user_id, "missing user id from access token"

    title = f"Admin test {uuid.uuid4().hex[:8]}"
    body = f"Hello from tests {uuid.uuid4().hex[:8]}"

    resp = requests.post(
        f"{api_url}/admin/notifications",
        headers=admin_headers(service_key),
        json={
            "title": title,
            "body": body,
            "audience": "users",
            "user_ids": [user_id],
        },
        timeout=20,
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    broadcast_id = payload.get("broadcast_id")
    assert broadcast_id, "missing broadcast_id"
    assert payload.get("sent_count") == 1

    list_resp = requests.get(
        f"{api_url}/notifications",
        headers=auth_headers(access_token),
        timeout=20,
    )
    assert list_resp.status_code == 200, list_resp.text
    notifications = list_resp.json().get("notifications") or []
    assert any(
        n.get("title") == title and n.get("body") == body
        for n in notifications
    ), "broadcast notification not found in user inbox"

    ledger_resp = requests.get(
        f"{api_url}/admin/notifications?limit=50",
        headers=admin_headers(service_key),
        timeout=20,
    )
    assert ledger_resp.status_code == 200, ledger_resp.text
    rows = ledger_resp.json().get("rows") or []
    assert any(
        row.get("id") == broadcast_id and row.get("sent_count") == 1
        for row in rows
    ), "broadcast ledger entry missing"


@pytest.mark.local
@pytest.mark.integration
def test_admin_broadcast_notification_all_audience() -> None:
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not service_key or not supabase_url:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = resolve_api_url(supabase_url, env)
    token_a = ensure_access_token(service_key, supabase_url)
    token_b = ensure_access_token(service_key, supabase_url)
    user_a = decode_jwt_sub(token_a)
    user_b = decode_jwt_sub(token_b)
    assert user_a and user_b
    ensure_user_profile_row(supabase_url, service_key, user_a)
    ensure_user_profile_row(supabase_url, service_key, user_b)
    ensure_credit_balance(api_url, token_a)
    ensure_credit_balance(api_url, token_b)

    title = f"Admin all {uuid.uuid4().hex[:8]}"
    body = f"Hello all {uuid.uuid4().hex[:8]}"

    resp = requests.post(
        f"{api_url}/admin/notifications",
        headers=admin_headers(service_key),
        json={
            "title": title,
            "body": body,
            "audience": "all",
        },
        timeout=20,
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert int(payload.get("sent_count") or 0) >= 2

    list_a = requests.get(
        f"{api_url}/notifications",
        headers=auth_headers(token_a),
        timeout=20,
    )
    assert list_a.status_code == 200, list_a.text
    items_a = list_a.json().get("notifications") or []
    assert any(
        n.get("title") == title and n.get("body") == body
        for n in items_a
    ), "broadcast missing for user A"

    list_b = requests.get(
        f"{api_url}/notifications",
        headers=auth_headers(token_b),
        timeout=20,
    )
    assert list_b.status_code == 200, list_b.text
    items_b = list_b.json().get("notifications") or []
    assert any(
        n.get("title") == title and n.get("body") == body
        for n in items_b
    ), "broadcast missing for user B"
