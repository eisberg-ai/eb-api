"""
Backend lifecycle tests - covers:
- Enabling backend
- Service restriction (services require backend)
- Backend stats endpoints (DB, Functions, Auth)
- Destroying backend
- Service deletion
"""
from __future__ import annotations

import logging

import pytest
import requests

from test.utils import (
    admin_headers,
    auth_headers,
    create_project,
    ensure_access_token,
    ensure_credit_balance,
    resolve_api_url,
    resolve_env,
)

logger = logging.getLogger(__name__)


def enable_backend(api_url: str, access_token: str, project_id: str) -> dict:
    """Enable backend for a project."""
    resp = requests.patch(
        f"{api_url}/projects/{project_id}",
        json={"backend_enabled": True},
        headers=auth_headers(access_token),
        timeout=20,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"failed to enable backend: {resp.status_code} {resp.text}")
    return resp.json()


def disable_backend(api_url: str, access_token: str, project_id: str) -> dict:
    """Disable backend for a project."""
    resp = requests.patch(
        f"{api_url}/projects/{project_id}",
        json={"backend_enabled": False},
        headers=auth_headers(access_token),
        timeout=20,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"failed to disable backend: {resp.status_code} {resp.text}")
    return resp.json()


@pytest.mark.integration
def test_backend_enable_disable() -> None:
    """Test enabling and disabling backend for a project."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    user_headers = auth_headers(access_token)
    project_id = create_project(api_url, access_token, name="Backend Test Project")

    # Verify project starts with backend disabled
    project_resp = requests.get(
        f"{api_url}/projects/{project_id}",
        headers=user_headers,
        timeout=20,
    )
    assert project_resp.status_code == 200
    project_data = project_resp.json()
    assert project_data.get("backend_enabled") is False, "backend should be disabled by default"

    # Enable backend
    enable_backend(api_url, access_token, project_id)

    # Verify backend is now enabled
    project_resp = requests.get(
        f"{api_url}/projects/{project_id}",
        headers=user_headers,
        timeout=20,
    )
    assert project_resp.status_code == 200
    project_data = project_resp.json()
    assert project_data.get("backend_enabled") is True, "backend should be enabled"
    assert project_data.get("backend_app_id") is not None, "backend_app_id should be set"

    # Disable backend
    disable_backend(api_url, access_token, project_id)

    # Verify backend is now disabled
    project_resp = requests.get(
        f"{api_url}/projects/{project_id}",
        headers=user_headers,
        timeout=20,
    )
    assert project_resp.status_code == 200
    project_data = project_resp.json()
    assert project_data.get("backend_enabled") is False, "backend should be disabled"


@pytest.mark.integration
def test_services_require_backend() -> None:
    """Test that services cannot be enabled without backend."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    user_headers = auth_headers(access_token)
    service_headers = admin_headers(service_key)
    project_id = create_project(api_url, access_token, name="Service Restriction Test")

    # Get available services
    services_resp = requests.get(f"{api_url}/services", headers=user_headers, timeout=20)
    assert services_resp.status_code == 200
    services = services_resp.json()
    text_services = services.get("text", [])
    assert text_services, "no text services returned"
    stub = text_services[0].get("stub")

    # Try to enable service without backend - should fail
    enable_resp = requests.post(
        f"{api_url}/projects/{project_id}/services",
        json={"serviceStub": stub, "config": {}},
        headers=service_headers,
        timeout=20,
    )
    assert enable_resp.status_code == 400, f"expected 400, got {enable_resp.status_code}"
    payload = enable_resp.json()
    assert payload.get("error") == "backend_required", f"expected backend_required error: {payload}"

    # Enable backend
    enable_backend(api_url, access_token, project_id)

    # Now enabling service should work
    enable_resp = requests.post(
        f"{api_url}/projects/{project_id}/services",
        json={"serviceStub": stub, "config": {}},
        headers=service_headers,
        timeout=20,
    )
    assert enable_resp.status_code == 200, f"expected 200, got {enable_resp.status_code}: {enable_resp.text}"


@pytest.mark.integration
def test_backend_stats_endpoints() -> None:
    """Test backend stats endpoints (DB, Functions, Auth)."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    user_headers = auth_headers(access_token)
    project_id = create_project(api_url, access_token, name="Backend Stats Test")

    # Get backend status before enabling
    status_resp = requests.get(
        f"{api_url}/projects/{project_id}/backend",
        headers=user_headers,
        timeout=20,
    )
    assert status_resp.status_code == 200
    status = status_resp.json()
    assert status.get("enabled") is False
    assert status.get("db") is None
    assert status.get("functions") is None
    assert status.get("auth") is None

    # Enable backend
    enable_backend(api_url, access_token, project_id)

    # Get backend status after enabling
    status_resp = requests.get(
        f"{api_url}/projects/{project_id}/backend",
        headers=user_headers,
        timeout=20,
    )
    assert status_resp.status_code == 200
    status = status_resp.json()
    assert status.get("enabled") is True
    assert status.get("app_id") is not None
    # DB stats should exist (even if empty)
    assert status.get("db") is not None
    assert "tables" in status["db"]
    assert "total_rows" in status["db"]
    # Functions stats should exist
    assert status.get("functions") is not None
    assert "endpoints" in status["functions"]
    assert "total_invocations" in status["functions"]
    # Auth stats should exist
    assert status.get("auth") is not None
    assert "users" in status["auth"]
    assert "roles" in status["auth"]

    # Test individual stats endpoints
    # DB endpoint
    db_resp = requests.get(
        f"{api_url}/projects/{project_id}/backend/db",
        headers=user_headers,
        timeout=20,
    )
    assert db_resp.status_code == 200
    db_data = db_resp.json()
    assert "schema" in db_data
    assert "tables" in db_data

    # Functions endpoint
    func_resp = requests.get(
        f"{api_url}/projects/{project_id}/backend/functions",
        headers=user_headers,
        timeout=20,
    )
    assert func_resp.status_code == 200
    func_data = func_resp.json()
    assert "functions" in func_data
    assert "total_invocations" in func_data

    # Auth endpoint
    auth_resp = requests.get(
        f"{api_url}/projects/{project_id}/backend/auth",
        headers=user_headers,
        timeout=20,
    )
    assert auth_resp.status_code == 200
    auth_data = auth_resp.json()
    assert "users" in auth_data
    assert "total_users" in auth_data
    assert "roles" in auth_data


@pytest.mark.integration
def test_backend_stats_require_backend() -> None:
    """Test that backend stats endpoints require backend to be enabled."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    user_headers = auth_headers(access_token)
    project_id = create_project(api_url, access_token, name="Backend Stats Auth Test")

    # DB endpoint should fail without backend
    db_resp = requests.get(
        f"{api_url}/projects/{project_id}/backend/db",
        headers=user_headers,
        timeout=20,
    )
    assert db_resp.status_code == 400
    assert db_resp.json().get("error") == "backend_not_enabled"

    # Functions endpoint should fail without backend
    func_resp = requests.get(
        f"{api_url}/projects/{project_id}/backend/functions",
        headers=user_headers,
        timeout=20,
    )
    assert func_resp.status_code == 400
    assert func_resp.json().get("error") == "backend_not_enabled"

    # Auth endpoint should fail without backend
    auth_resp = requests.get(
        f"{api_url}/projects/{project_id}/backend/auth",
        headers=user_headers,
        timeout=20,
    )
    assert auth_resp.status_code == 400
    assert auth_resp.json().get("error") == "backend_not_enabled"


@pytest.mark.integration
def test_backend_destroy() -> None:
    """Test destroying backend completely."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    user_headers = auth_headers(access_token)
    service_headers = admin_headers(service_key)
    project_id = create_project(api_url, access_token, name="Backend Destroy Test")

    # Enable backend
    enable_backend(api_url, access_token, project_id)

    # Get available services and enable one
    services_resp = requests.get(f"{api_url}/services", headers=user_headers, timeout=20)
    services = services_resp.json()
    stub = services.get("text", [{}])[0].get("stub")
    if stub:
        requests.post(
            f"{api_url}/projects/{project_id}/services",
            json={"serviceStub": stub, "config": {}},
            headers=service_headers,
            timeout=20,
        )

    # Try to destroy without confirmation - should fail
    destroy_resp = requests.delete(
        f"{api_url}/projects/{project_id}/backend/destroy",
        headers=user_headers,
        timeout=20,
    )
    assert destroy_resp.status_code == 400
    assert destroy_resp.json().get("error") == "confirmation_required"

    # Try with wrong confirmation - should fail
    destroy_resp = requests.delete(
        f"{api_url}/projects/{project_id}/backend/destroy",
        json={"confirm": "delete"},  # lowercase
        headers=user_headers,
        timeout=20,
    )
    assert destroy_resp.status_code == 400

    # Destroy with correct confirmation
    destroy_resp = requests.delete(
        f"{api_url}/projects/{project_id}/backend/destroy",
        json={"confirm": "DELETE"},
        headers=user_headers,
        timeout=20,
    )
    assert destroy_resp.status_code == 200
    destroy_data = destroy_resp.json()
    assert destroy_data.get("deleted") is True
    assert "cleanup_summary" in destroy_data

    # Verify backend is disabled
    project_resp = requests.get(
        f"{api_url}/projects/{project_id}",
        headers=user_headers,
        timeout=20,
    )
    assert project_resp.status_code == 200
    project_data = project_resp.json()
    assert project_data.get("backend_enabled") is False
    assert project_data.get("backend_app_id") is None

    # Verify services were removed
    services_resp = requests.get(
        f"{api_url}/projects/{project_id}/services",
        headers=service_headers,
        timeout=20,
    )
    assert services_resp.status_code == 200
    services_data = services_resp.json()
    assert len(services_data.get("services", [])) == 0


@pytest.mark.integration
def test_service_deletion() -> None:
    """Test deleting individual services from a project."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    user_headers = auth_headers(access_token)
    service_headers = admin_headers(service_key)
    project_id = create_project(api_url, access_token, name="Service Delete Test")

    # Enable backend
    enable_backend(api_url, access_token, project_id)

    # Get available services
    services_resp = requests.get(f"{api_url}/services", headers=user_headers, timeout=20)
    services = services_resp.json()
    text_services = services.get("text", [])
    assert len(text_services) >= 1, "need at least 1 text service"
    stub = text_services[0].get("stub")

    # Enable the service
    enable_resp = requests.post(
        f"{api_url}/projects/{project_id}/services",
        json={"serviceStub": stub, "config": {}},
        headers=service_headers,
        timeout=20,
    )
    assert enable_resp.status_code == 200

    # Verify service is enabled
    project_services_resp = requests.get(
        f"{api_url}/projects/{project_id}/services",
        headers=service_headers,
        timeout=20,
    )
    assert project_services_resp.status_code == 200
    project_services = project_services_resp.json().get("services", [])
    assert any(s.get("stub") == stub for s in project_services), "service should be enabled"

    # Delete the service
    delete_resp = requests.delete(
        f"{api_url}/projects/{project_id}/services/{stub}",
        headers=service_headers,
        timeout=20,
    )
    assert delete_resp.status_code == 200

    # Verify service is deleted
    project_services_resp = requests.get(
        f"{api_url}/projects/{project_id}/services",
        headers=service_headers,
        timeout=20,
    )
    assert project_services_resp.status_code == 200
    project_services = project_services_resp.json().get("services", [])
    assert not any(s.get("stub") == stub for s in project_services), "service should be deleted"


@pytest.mark.integration
def test_backend_re_enable_after_destroy() -> None:
    """Test that backend can be re-enabled after being destroyed."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.prod")

    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    ensure_credit_balance(api_url, access_token)

    user_headers = auth_headers(access_token)
    project_id = create_project(api_url, access_token, name="Backend Re-enable Test")

    # Enable backend
    enable_backend(api_url, access_token, project_id)

    # Get app_id
    project_resp = requests.get(f"{api_url}/projects/{project_id}", headers=user_headers, timeout=20)
    first_app_id = project_resp.json().get("backend_app_id")
    assert first_app_id is not None

    # Destroy backend
    destroy_resp = requests.delete(
        f"{api_url}/projects/{project_id}/backend/destroy",
        json={"confirm": "DELETE"},
        headers=user_headers,
        timeout=20,
    )
    assert destroy_resp.status_code == 200

    # Re-enable backend
    enable_backend(api_url, access_token, project_id)

    # Get new app_id - should be different
    project_resp = requests.get(f"{api_url}/projects/{project_id}", headers=user_headers, timeout=20)
    second_app_id = project_resp.json().get("backend_app_id")
    assert second_app_id is not None
    assert second_app_id != first_app_id, "new app_id should be generated after destroy"
