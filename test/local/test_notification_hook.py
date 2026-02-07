"""
Notification service hook tests.
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


@pytest.mark.local
@pytest.mark.integration
def test_service_can_send_notification_to_user() -> None:
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not service_key or not supabase_url:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    user_id = decode_jwt_sub(access_token)
    assert user_id, "missing user id from access token"

    title = f"Build complete {uuid.uuid4().hex[:8]}"
    body = f"Build finished {uuid.uuid4().hex[:8]}"

    resp = requests.post(
        f"{api_url}/notifications/send",
        headers=admin_headers(service_key),
        json={
            "user_id": user_id,
            "title": title,
            "body": body,
            "type": "build_complete",
        },
        timeout=20,
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    notification = payload.get("notification") or {}
    assert notification.get("title") == title

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
    ), "notification not found in inbox"
