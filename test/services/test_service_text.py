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
    get_credit_balance,
    resolve_api_url,
    resolve_env,
    spend_credits,
)

logger = logging.getLogger(__name__)

def require_text_success(resp: requests.Response, stub: str) -> None:
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
    payload = resp.json()
    choice = (payload.get("choices") or [{}])[0]
    message = (choice.get("message") or {}).get("content") or ""
    assert message.strip(), f"{stub}: empty response content: {payload}"


@pytest.mark.integration
def test_text_service_proxies() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    headers = auth_headers(access_token)
    service_headers = admin_headers(service_key)
    project_id = create_project(api_url, access_token)

    services_resp = requests.get(f"{api_url}/services", headers=headers, timeout=20)
    assert services_resp.status_code == 200, services_resp.text
    services = services_resp.json()
    assert isinstance(services, dict), services

    entries = services.get("text", [])
    assert entries, "no text services returned"
    for service in entries:
        stub = service.get("stub")
        assert stub, "missing stub for text service"
        logger.info("service:text enable %s", stub)
        enable_payload = {"serviceStub": stub, "config": {}}
        enable_resp = requests.post(
            f"{api_url}/projects/{project_id}/services",
            json=enable_payload,
            headers=service_headers,
            timeout=20,
        )
        assert enable_resp.status_code == 200, enable_resp.text

        project_service_key = create_project_service_key(api_url, service_key, project_id, stub)
        project_service_headers = {"x-project-service-key": project_service_key, "Content-Type": "application/json"}
        proxy_url = f"{api_url}/services/text/{stub}?projectId={project_id}"
        proxy_payload = {"messages": [{"role": "user", "content": "Hello from tests."}]}
        logger.info("service:text proxy %s", stub)
        proxy_resp = requests.post(
            proxy_url,
            data=json.dumps(proxy_payload),
            headers=project_service_headers,
            timeout=30,
        )
        logger.info("service:text status %s -> %s", stub, proxy_resp.status_code)
        require_text_success(proxy_resp, stub)


@pytest.mark.integration
def test_text_service_disables_on_insufficient_balance() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    headers = auth_headers(access_token)
    service_headers = admin_headers(service_key)
    project_id = create_project(api_url, access_token)

    services_resp = requests.get(f"{api_url}/services", headers=headers, timeout=20)
    assert services_resp.status_code == 200, services_resp.text
    services = services_resp.json()
    entries = services.get("text", [])
    assert entries, "no text services returned"
    stub = entries[0].get("stub")
    assert stub, "missing stub for text service"

    enable_resp = requests.post(
        f"{api_url}/projects/{project_id}/services",
        json={"serviceStub": stub, "config": {}},
        headers=service_headers,
        timeout=20,
    )
    assert enable_resp.status_code == 200, enable_resp.text

    balance = get_credit_balance(api_url, access_token)
    spend_credits(api_url, access_token, balance, description="drain for service disable test")

    project_service_key = create_project_service_key(api_url, service_key, project_id, stub)
    project_service_headers = {"x-project-service-key": project_service_key, "Content-Type": "application/json"}
    proxy_url = f"{api_url}/services/text/{stub}?projectId={project_id}"
    proxy_payload = {"messages": [{"role": "user", "content": "Hello from tests."}]}
    proxy_resp = requests.post(
        proxy_url,
        data=json.dumps(proxy_payload),
        headers=project_service_headers,
        timeout=30,
    )
    assert proxy_resp.status_code == 400, proxy_resp.text
    payload = proxy_resp.json()
    assert payload.get("error") == "insufficient_balance", payload

    services_resp = requests.get(
        f"{api_url}/projects/{project_id}/services",
        headers=service_headers,
        timeout=20,
    )
    assert services_resp.status_code == 200, services_resp.text
    services_payload = services_resp.json()
    service_rows = services_payload.get("services", [])
    service_entry = next((row for row in service_rows if row.get("stub") == stub), None)
    assert service_entry, f"{stub} missing from project services"
    assert service_entry.get("enabled") is False, service_entry
    assert service_entry.get("disabledReason") == "insufficient_balance", service_entry
