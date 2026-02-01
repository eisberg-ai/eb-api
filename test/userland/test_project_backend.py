"""Project backend enablement grants userland access."""
from __future__ import annotations

import uuid

import pytest

from test.userland.conftest import approve_user, request_json, sign_up_user


def _fetch_project_backend(supabase_url: str, service_key: str, project_id: str) -> dict:
    rows = request_json(
        f"{supabase_url}/rest/v1/projects?select=backend_enabled,backend_app_id&id=eq.{project_id}",
        api_key=service_key,
        token=service_key,
    )
    if not rows:
        raise AssertionError("project backend row missing")
    return rows[0]


def _fetch_app_user(supabase_url: str, service_key: str, app_id: str, user_id: str) -> list[dict]:
    return request_json(
        f"{supabase_url}/rest/v1/app_users?select=app_id,user_id,role&app_id=eq.{app_id}&user_id=eq.{user_id}",
        api_key=service_key,
        token=service_key,
    )


@pytest.mark.integration
def test_project_backend_enablement_creates_userland_access(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    user = sign_up_user(supabase_url, api_url, anon_key, "backend-enable")
    approve_user(api_url, service_key, user["userId"])
    project_id = f"project-backend-{uuid.uuid4().hex[:8]}"
    request_json(
        f"{api_url}/projects",
        method="POST",
        api_key=anon_key,
        token=user["token"],
        body={"id": project_id, "name": "Backend Enablement"},
    )
    initial = _fetch_project_backend(supabase_url, service_key, project_id)
    assert initial.get("backend_enabled") is False
    assert initial.get("backend_app_id") is None

    request_json(
        f"{api_url}/projects/{project_id}",
        method="PATCH",
        api_key=anon_key,
        token=user["token"],
        body={"backend_enabled": True},
    )
    enabled = _fetch_project_backend(supabase_url, service_key, project_id)
    assert enabled.get("backend_enabled") is True
    app_id = enabled.get("backend_app_id")
    assert app_id
    uuid.UUID(app_id)

    members = _fetch_app_user(supabase_url, service_key, app_id, user["userId"])
    assert members
    assert members[0]["role"] == "owner"
