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

def assert_non_text_response(resp: requests.Response, stub: str) -> None:
    if resp.status_code == 501:
        return
    if resp.status_code == 400:
        payload = resp.json()
        assert payload.get("error") == "insufficient_balance", payload
        return
    raise AssertionError(f"unexpected status for image service {stub}: {resp.status_code} {resp.text}")


@pytest.mark.integration
def test_image_service_proxies() -> None:
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

    entries = services.get("image", [])
    assert entries, "no image services returned"
    for service in entries:
        stub = service.get("stub")
        assert stub, "missing stub for image service"
        logger.info("service:image enable %s", stub)
        enable_payload = {"serviceStub": stub}
        enable_resp = requests.post(
            f"{api_url}/projects/{project_id}/services",
            json=enable_payload,
            headers=service_headers,
            timeout=20,
        )
        assert enable_resp.status_code == 200, enable_resp.text

        project_service_key = create_project_service_key(api_url, service_key, project_id, stub)
        project_service_headers = {"x-project-service-key": project_service_key, "Content-Type": "application/json"}
        proxy_url = f"{api_url}/services/image/{stub}?projectId={project_id}"
        logger.info("service:image proxy %s", stub)
        proxy_resp = requests.post(
            proxy_url,
            data=json.dumps({}),
            headers=project_service_headers,
            timeout=30,
        )
        logger.info("service:image status %s -> %s", stub, proxy_resp.status_code)
        assert_non_text_response(proxy_resp, stub)
