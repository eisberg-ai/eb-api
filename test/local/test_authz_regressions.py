"""
AuthZ regression tests for known gaps.

These tests assert expected auth/ownership behavior and should fail until fixed.
"""
from __future__ import annotations

import uuid

import pytest
import requests

from test.utils import (
    approve_user,
    auth_headers,
    resolve_api_url,
    resolve_env,
    sign_up_user,
)

pytestmark = [pytest.mark.local, pytest.mark.integration]


def _make_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _rest_headers(service_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _rest_insert(supabase_url: str, service_key: str, table: str, rows: list[dict]) -> None:
    url = f"{supabase_url}/rest/v1/{table}"
    resp = requests.post(url, headers=_rest_headers(service_key), json=rows, timeout=15)
    assert resp.status_code in (200, 201, 204), f"rest insert {table} failed: {resp.status_code} {resp.text}"


@pytest.fixture(scope="module")
def env() -> dict[str, str]:
    return resolve_env()


@pytest.fixture(scope="module")
def supabase_url(env: dict[str, str]) -> str:
    return (env.get("SUPABASE_URL") or "http://127.0.0.1:54321").rstrip("/")


@pytest.fixture(scope="module")
def api_url(supabase_url: str, env: dict[str, str]) -> str:
    return resolve_api_url(supabase_url, env)


@pytest.fixture(scope="module")
def anon_key(env: dict[str, str]) -> str:
    key = env.get("SUPABASE_ANON_KEY")
    if not key:
        pytest.skip("SUPABASE_ANON_KEY required for authz tests")
    return key


@pytest.fixture(scope="module")
def service_key(env: dict[str, str]) -> str:
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY required for authz tests")
    return key


@pytest.fixture(scope="module")
def authz_data(
    supabase_url: str,
    api_url: str,
    anon_key: str,
    service_key: str,
) -> dict[str, str | int | dict]:
    owner = sign_up_user(supabase_url, api_url, anon_key, "authz-owner")
    other = sign_up_user(supabase_url, api_url, anon_key, "authz-other")
    approve_user(api_url, service_key, owner["userId"])
    approve_user(api_url, service_key, other["userId"])

    project_id = _make_id("project-authz")
    build_id = _make_id("build-authz")
    job_id = _make_id("job-authz")
    message_id = _make_id("message-authz")
    version_number = 1

    _rest_insert(
        supabase_url,
        service_key,
        "projects",
        [
            {
                "id": project_id,
                "name": "AuthZ Project",
                "owner_user_id": owner["userId"],
                "current_version_number": version_number,
                "latest_build_id": build_id,
                "model": "claude-sonnet-4-5",
            }
        ],
    )
    _rest_insert(
        supabase_url,
        service_key,
        "jobs",
        [
            {
                "job_id": job_id,
                "project_id": project_id,
                "status": "queued",
            }
        ],
    )
    _rest_insert(
        supabase_url,
        service_key,
        "builds",
        [
            {
                "id": build_id,
                "project_id": project_id,
                "job_id": job_id,
                "version_number": version_number,
                "status": "succeeded",
                "is_promoted": True,
                "source": "ZGF0YQ==",
                "source_encoding": "base64",
            }
        ],
    )
    _rest_insert(
        supabase_url,
        service_key,
        "messages",
        [
            {
                "id": message_id,
                "project_id": project_id,
                "role": "user",
                "type": "talk",
                "content": [{"kind": "text", "text": "hello from authz"}],
            }
        ],
    )
    _rest_insert(
        supabase_url,
        service_key,
        "vms",
        [
            {
                "project_id": project_id,
                "mode": "serving",
                "runtime_state": "serving",
            }
        ],
    )

    return {
        "project_id": project_id,
        "build_id": build_id,
        "job_id": job_id,
        "message_id": message_id,
        "version_number": version_number,
        "owner": owner,
        "other": other,
    }


def test_build_endpoints_require_auth(api_url: str, authz_data: dict[str, str | int | dict]) -> None:
    project_id = authz_data["project_id"]
    build_id = authz_data["build_id"]
    job_id = authz_data["job_id"]

    create_resp = requests.post(
        f"{api_url}/builds",
        json={"id": _make_id("build-unauth"), "project_id": project_id, "version_number": 1},
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    assert create_resp.status_code in (401, 403)

    get_resp = requests.get(f"{api_url}/builds/{build_id}", timeout=15)
    assert get_resp.status_code in (401, 403)

    patch_resp = requests.patch(
        f"{api_url}/builds/{build_id}",
        json={"metadata": {"authz": "test"}},
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    assert patch_resp.status_code in (401, 403)

    job_resp = requests.get(f"{api_url}/builds?jobId={job_id}", timeout=15)
    assert job_resp.status_code in (401, 403)


def test_project_read_requires_owner(api_url: str, authz_data: dict[str, str | int | dict]) -> None:
    project_id = authz_data["project_id"]
    other = authz_data["other"]
    resp = requests.get(
        f"{api_url}/projects/{project_id}",
        headers=auth_headers(other["token"]),
        timeout=15,
    )
    assert resp.status_code == 403


def test_project_chat_requires_auth(api_url: str, authz_data: dict[str, str | int | dict]) -> None:
    project_id = authz_data["project_id"]
    resp = requests.get(f"{api_url}/projects/{project_id}/chat", timeout=15)
    assert resp.status_code == 401


def test_project_messages_require_auth(api_url: str, authz_data: dict[str, str | int | dict]) -> None:
    project_id = authz_data["project_id"]
    resp = requests.post(
        f"{api_url}/projects/{project_id}/messages",
        json={
            "id": _make_id("message-unauth"),
            "role": "user",
            "type": "talk",
            "content": [{"kind": "text", "text": "unauth message"}],
        },
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    assert resp.status_code == 401


def test_project_versions_require_owner(api_url: str, authz_data: dict[str, str | int | dict]) -> None:
    project_id = authz_data["project_id"]
    other = authz_data["other"]
    resp = requests.get(
        f"{api_url}/projects/versions?projectId={project_id}",
        headers=auth_headers(other["token"]),
        timeout=15,
    )
    assert resp.status_code == 403


def test_project_version_source_requires_auth(api_url: str, authz_data: dict[str, str | int | dict]) -> None:
    project_id = authz_data["project_id"]
    version_number = authz_data["version_number"]

    get_resp = requests.get(
        f"{api_url}/projects/{project_id}/versions/{version_number}/source",
        timeout=15,
    )
    assert get_resp.status_code in (401, 403)

    post_resp = requests.post(
        f"{api_url}/projects/{project_id}/versions/{version_number}/source",
        json={"source": "ZGF0YS11cGRhdGU=", "encoding": "base64"},
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    assert post_resp.status_code in (401, 403)


def test_worker_jobs_list_requires_auth(api_url: str) -> None:
    resp = requests.get(f"{api_url}/worker/jobs", timeout=15)
    assert resp.status_code in (401, 403)


def test_vm_lookup_requires_owner(api_url: str, authz_data: dict[str, str | int | dict]) -> None:
    project_id = authz_data["project_id"]
    other = authz_data["other"]
    resp = requests.get(
        f"{api_url}/vms/{project_id}",
        headers=auth_headers(other["token"]),
        timeout=15,
    )
    assert resp.status_code == 403
