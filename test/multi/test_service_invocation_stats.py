from __future__ import annotations

import json
import logging

import pytest
import requests

from test.utils import (
    admin_headers,
    auth_headers,
    create_project,
    create_project_service_key,
    ensure_access_token,
    ensure_credit_balance,
    resolve_api_url,
    resolve_env,
)

logger = logging.getLogger(__name__)


def _require_text_success(resp: requests.Response, stub: str) -> None:
    if resp.status_code != 200:
        try:
            payload = resp.json()
        except ValueError:
            payload = {"raw": resp.text}
        if resp.status_code == 400 and payload.get("error") == "insufficient_balance":
            pytest.fail(f"{stub}: insufficient_balance (seed credits for this user/project)")
        if resp.status_code == 400 and payload.get("error") == "service_key_missing":
            pytest.fail(f"{stub}: service_key_missing (configure provider keys in the api env)")
        if resp.status_code == 500:
            pytest.fail(f"{stub}: provider error {payload}")
        pytest.fail(f"{stub}: unexpected status {resp.status_code} payload={payload}")


def _get_service_entry(api_url: str, headers: dict, project_id: str, stub: str) -> dict:
    resp = requests.get(
        f"{api_url}/projects/{project_id}/services",
        headers=headers,
        timeout=20,
    )
    assert resp.status_code == 200, resp.text
    services = resp.json().get("services", [])
    entry = next((s for s in services if s.get("stub") == stub), None)
    assert entry is not None, f"{stub} not found in project services: {services}"
    return entry


@pytest.mark.integration
def test_service_invocation_tracking() -> None:
    """Verify that invocation_count and last_invoked_at are updated after proxy calls."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    service_headers = admin_headers(service_key)
    project_id = create_project(api_url, access_token)

    # Enable backend (required before adding services)
    backend_resp = requests.patch(
        f"{api_url}/projects/{project_id}",
        json={"backend_enabled": True},
        headers=service_headers,
        timeout=20,
    )
    assert backend_resp.status_code == 200, f"failed to enable backend: {backend_resp.text}"

    # Pick the first available text service
    user_headers = auth_headers(access_token)
    services_resp = requests.get(f"{api_url}/services", headers=user_headers, timeout=20)
    assert services_resp.status_code == 200, services_resp.text
    text_services = services_resp.json().get("text", [])
    assert text_services, "no text services returned"
    stub = text_services[0]["stub"]

    # Enable the service
    enable_resp = requests.post(
        f"{api_url}/projects/{project_id}/services",
        json={"serviceStub": stub, "config": {}},
        headers=service_headers,
        timeout=20,
    )
    assert enable_resp.status_code == 200, enable_resp.text

    # Create a service key for proxy auth
    project_service_key = create_project_service_key(api_url, service_key, project_id, stub)
    proxy_headers = {"x-project-service-key": project_service_key, "Content-Type": "application/json"}
    proxy_url = f"{api_url}/services/text/{stub}?projectId={project_id}"
    proxy_payload = {"messages": [{"role": "user", "content": "Hello from invocation stats test."}]}

    # Before any calls: invocationCount should be 0
    entry = _get_service_entry(api_url, service_headers, project_id, stub)
    assert entry.get("invocationCount") == 0, f"expected 0 invocations initially, got {entry}"
    assert entry.get("lastInvokedAt") is None, f"expected null lastInvokedAt initially, got {entry}"

    # First proxy call
    resp1 = requests.post(proxy_url, data=json.dumps(proxy_payload), headers=proxy_headers, timeout=30)
    _require_text_success(resp1, stub)

    entry = _get_service_entry(api_url, service_headers, project_id, stub)
    assert entry.get("invocationCount") == 1, f"expected 1 invocation after first call, got {entry}"
    assert entry.get("lastInvokedAt") is not None, f"expected lastInvokedAt set after first call, got {entry}"
    first_invoked_at = entry["lastInvokedAt"]

    # Second proxy call
    resp2 = requests.post(proxy_url, data=json.dumps(proxy_payload), headers=proxy_headers, timeout=30)
    _require_text_success(resp2, stub)

    entry = _get_service_entry(api_url, service_headers, project_id, stub)
    assert entry.get("invocationCount") == 2, f"expected 2 invocations after second call, got {entry}"
    assert entry.get("lastInvokedAt") is not None, "expected lastInvokedAt set after second call"
    assert entry["lastInvokedAt"] >= first_invoked_at, "lastInvokedAt should not go backwards"

    logger.info("invocation tracking verified: count=%d lastInvokedAt=%s", entry["invocationCount"], entry["lastInvokedAt"])
