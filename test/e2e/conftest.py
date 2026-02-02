"""E2E test fixtures for full app lifecycle tests."""
from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any, Generator

import pytest
import requests

from test.utils import approve_user, auth_headers, load_env_file, resolve_api_url, resolve_env, sign_up_user


def _get_eb_api_supabase_config() -> dict[str, str]:
    """Get eb-api's Supabase config (before any userland overrides).

    The vms table, users, projects, and builds all live in eb-api's database.
    This function reads .env.local directly to get the original values,
    avoiding the BACKEND_BASE_URL override that points to eb-userland.
    """
    # First check explicit env vars
    result = {
        "url": os.environ.get("EB_API_SUPABASE_URL"),
        "service_key": os.environ.get("EB_API_SERVICE_ROLE_KEY"),
        "anon_key": os.environ.get("EB_API_SUPABASE_ANON_KEY"),
    }
    if all(result.values()):
        result["url"] = result["url"].rstrip("/")
        return result

    # Read .env.local directly (before apply_backend_base_overrides)
    root = Path(__file__).resolve().parents[2]
    local_env = load_env_file(root / ".env.local")

    result["url"] = (result["url"] or local_env.get("SUPABASE_URL") or "http://127.0.0.1:54321").rstrip("/")
    result["service_key"] = result["service_key"] or local_env.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    result["anon_key"] = result["anon_key"] or local_env.get("SUPABASE_ANON_KEY") or ""
    return result


def _check_api_health(api_url: str) -> tuple[bool, str]:
    """Check if eb-api is reachable and responding."""
    try:
        # Use a lightweight endpoint - builds list requires no auth
        resp = requests.get(f"{api_url}/health", timeout=5)
        if resp.status_code < 500:
            return True, "API is reachable"
        return False, f"API returned {resp.status_code}"
    except requests.exceptions.ConnectionError:
        return False, f"Cannot connect to API at {api_url}"
    except requests.exceptions.Timeout:
        return False, f"API request timed out at {api_url}"


def _check_vms_available(supabase_url: str, service_key: str) -> tuple[bool, str]:
    """Check if VMs are available in the pool by querying the vms table directly."""
    try:
        # Query vms table directly via PostgREST
        rest_url = f"{supabase_url}/rest/v1/vms?select=id,status&status=eq.idle"
        resp = requests.get(
            rest_url,
            headers={
                "Authorization": f"Bearer {service_key}",
                "apikey": service_key,
            },
            timeout=10,
        )
        if resp.status_code == 404:
            return False, "vms table not found (run migrations?)"
        if resp.status_code != 200:
            return False, f"VM pool check failed: {resp.status_code}"
        idle_vms = resp.json()
        if not idle_vms:
            return False, "No idle VMs in pool"
        return True, f"{len(idle_vms)} idle VM(s) available"
    except requests.exceptions.ConnectionError:
        return False, "Cannot connect to Supabase for VM check"
    except requests.exceptions.Timeout:
        return False, "VM check request timed out"


def _check_userland_available(userland_url: str) -> tuple[bool, str]:
    """Check if eb-userland is reachable (for backend-enabled builds)."""
    if not userland_url:
        return False, "BACKEND_BASE_URL not configured"
    try:
        # Check if userland API is responding
        api_url = f"{userland_url.rstrip('/')}/functions/v1/api/health"
        resp = requests.get(api_url, timeout=5)
        if resp.status_code < 500:
            return True, f"userland reachable at {userland_url}"
        return False, f"userland returned {resp.status_code}"
    except requests.exceptions.ConnectionError:
        return False, f"Cannot connect to userland at {userland_url}"
    except requests.exceptions.Timeout:
        return False, f"userland request timed out at {userland_url}"


@pytest.fixture(scope="module")
def env() -> dict[str, str]:
    """Load environment variables."""
    return resolve_env()


@pytest.fixture(scope="module", autouse=True)
def check_prerequisites(env: dict[str, str]) -> None:
    """Verify all required services are running before e2e tests execute."""
    # Get eb-api's Supabase config (where vms table lives, before userland overrides)
    eb_api_config = _get_eb_api_supabase_config()
    eb_api_supabase_url = eb_api_config["url"]
    eb_api_service_key = eb_api_config["service_key"]

    # For API calls, use the potentially-overridden env
    supabase_url = (env.get("SUPABASE_URL") or "http://127.0.0.1:54321").rstrip("/")
    api_url = resolve_api_url(supabase_url, env)
    userland_url = env.get("BACKEND_BASE_URL")

    print("\n=== E2E Prerequisites Check ===")

    # Check 1: API is reachable
    api_ok, api_msg = _check_api_health(api_url)
    print(f"  eb-api: {api_msg}")
    if not api_ok:
        print("\n  To start eb-api:")
        print("    cd eb-api && task start")
        pytest.skip(f"eb-api not available: {api_msg}")

    # Check 2: Userland is reachable (for backend-enabled builds)
    if userland_url:
        userland_ok, userland_msg = _check_userland_available(userland_url)
        print(f"  eb-userland: {userland_msg}")
        if not userland_ok:
            print("\n  To start eb-userland:")
            print("    cd eb-userland && task dev:local")
            pytest.skip(f"eb-userland not available: {userland_msg}")
    else:
        print("  eb-userland: skipped (BACKEND_BASE_URL not set)")

    # Check 3: VMs available in eb-api Supabase (not userland)
    if eb_api_service_key:
        vm_ok, vm_msg = _check_vms_available(eb_api_supabase_url, eb_api_service_key)
        print(f"  VM pool: {vm_msg}")
        if not vm_ok:
            print("\n  To start a VM locally (Docker, recommended):")
            print("    cd eb-worker && task dev:docker")
            print("  Or pure Python (faster startup):")
            print("    cd eb-worker && task dev:local")
            print("  For production, ensure MIG has running instances.")
            pytest.skip(f"VM pool not ready: {vm_msg}")
    else:
        print("  VM pool: skipped (no service key)")

    print("=== Prerequisites OK ===\n")


@pytest.fixture(scope="module")
def supabase_url() -> str:
    """Return eb-api's Supabase URL (not userland's)."""
    return _get_eb_api_supabase_config()["url"]


@pytest.fixture(scope="module")
def api_url(supabase_url: str) -> str:
    """Return eb-api's API URL (not userland's)."""
    # Use eb-api's local Supabase API, not the userland override
    return f"{supabase_url}/functions/v1/api"


@pytest.fixture(scope="module")
def anon_key() -> str:
    """Return eb-api's anon key (not userland's)."""
    key = _get_eb_api_supabase_config()["anon_key"]
    if not key:
        pytest.skip("SUPABASE_ANON_KEY required for e2e tests (check .env.local)")
    return key


@pytest.fixture(scope="module")
def service_key() -> str:
    """Return eb-api's service key (not userland's)."""
    key = _get_eb_api_supabase_config()["service_key"]
    if not key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY required for e2e tests (check .env.local)")
    return key


@pytest.fixture(scope="function")
def test_user(
    supabase_url: str, api_url: str, anon_key: str, service_key: str
) -> Generator[dict[str, Any], None, None]:
    """Create and approve a test user, yield credentials."""
    user = sign_up_user(supabase_url, api_url, anon_key, "e2e-lifecycle")
    approve_user(api_url, service_key, user["userId"])

    # Ensure initial credits
    resp = requests.get(
        f"{api_url}/billing/credits",
        headers={"Authorization": f"Bearer {user['token']}"},
        timeout=15,
    )
    if resp.status_code != 200:
        pytest.fail(f"Failed to initialize credits: {resp.text}")

    yield user


@pytest.fixture(scope="function")
def test_project(
    api_url: str, test_user: dict[str, Any]
) -> Generator[str, None, None]:
    """Create a test project, yield ID, then cleanup."""
    project_id = f"project-e2e-{uuid.uuid4().hex[:8]}"

    # Create project
    resp = requests.post(
        f"{api_url}/projects",
        json={"id": project_id, "name": "E2E Full Lifecycle Test", "model": "claude-sonnet-4-5"},
        headers=auth_headers(test_user["token"]),
        timeout=20,
    )
    assert resp.status_code == 200, f"Failed to create project: {resp.text}"

    yield project_id

    # Cleanup: delete project (best effort)
    try:
        requests.delete(
            f"{api_url}/projects/{project_id}",
            headers=auth_headers(test_user["token"]),
            timeout=20,
        )
    except Exception:
        pass
