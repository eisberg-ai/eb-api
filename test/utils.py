from __future__ import annotations

import os
import uuid
from pathlib import Path

import requests


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def apply_userland_overrides(env: dict[str, str]) -> None:
    if env.get("USERLAND_SUPABASE_URL"):
        env["SUPABASE_URL"] = env["USERLAND_SUPABASE_URL"]
    if env.get("USERLAND_SUPABASE_ANON_KEY"):
        env["SUPABASE_ANON_KEY"] = env["USERLAND_SUPABASE_ANON_KEY"]
    if env.get("USERLAND_SUPABASE_SERVICE_ROLE_KEY"):
        env["SUPABASE_SERVICE_ROLE_KEY"] = env["USERLAND_SUPABASE_SERVICE_ROLE_KEY"]
    if env.get("USERLAND_API_URL"):
        env["API_URL"] = env["USERLAND_API_URL"]


def resolve_env() -> dict[str, str]:
    env = dict(os.environ)
    apply_userland_overrides(env)
    if env.get("SUPABASE_URL") and env.get("SUPABASE_SERVICE_ROLE_KEY"):
        return env
    root = Path(__file__).resolve().parents[1]
    env.update(load_env_file(root / ".env.local"))
    env.update(load_env_file(root / ".env.prod"))
    # Allow userland-specific overrides for running tests against a separate project.
    apply_userland_overrides(env)
    return env


def resolve_api_url(supabase_url: str, env: dict[str, str] | None = None) -> str:
    base = supabase_url.rstrip("/")
    if env and env.get("API_URL"):
        return env["API_URL"]
    return f"{base}/functions/v1/api"


def resolve_auth_url(supabase_url: str) -> str:
    base = supabase_url.rstrip("/")
    return f"{base}/auth/v1"


def ensure_access_token(service_key: str, supabase_url: str) -> str:
    email = f"prod-test-{uuid.uuid4().hex[:8]}@local.test"
    password = f"TestPass-{uuid.uuid4().hex[:8]}!"
    auth_url = resolve_auth_url(supabase_url)
    admin_url = f"{auth_url}/admin/generate_link"
    resp = requests.post(
        admin_url,
        json={"type": "signup", "email": email, "password": password},
        headers={
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "Content-Type": "application/json",
        },
        timeout=15,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"failed to create test user: {resp.status_code} {resp.text}")
    data = resp.json()
    action_link = data.get("properties", {}).get("action_link") or data.get("action_link") or ""
    access_token = None
    if "access_token=" in action_link:
        access_token = action_link.split("access_token=")[1].split("&")[0]
    if not access_token and action_link:
        try:
            resp = requests.get(action_link, allow_redirects=False, timeout=10)
            location = resp.headers.get("Location") or resp.headers.get("location") or ""
            if "access_token=" in location:
                access_token = location.split("access_token=")[1].split("&")[0]
        except Exception:
            access_token = None
    if not access_token:
        token_resp = requests.post(
            f"{auth_url}/token?grant_type=password",
            json={"email": email, "password": password},
            headers={"apikey": service_key, "Content-Type": "application/json"},
            timeout=10,
        )
        if token_resp.status_code == 200:
            access_token = (token_resp.json() or {}).get("access_token")
    if not access_token:
        raise RuntimeError("access_token missing from auth response")
    return access_token


def ensure_credit_balance(api_url: str, access_token: str) -> None:
    resp = requests.get(
        f"{api_url}/billing/credits",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"failed to init credits: {resp.status_code} {resp.text}")


def get_credit_balance(api_url: str, access_token: str) -> float:
    resp = requests.get(
        f"{api_url}/billing/credits",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"failed to get credits: {resp.status_code} {resp.text}")
    payload = resp.json()
    return float(payload.get("balance") or 0)


def spend_credits(api_url: str, access_token: str, credits: float, description: str = "test spend") -> None:
    if credits <= 0:
        return
    resp = requests.post(
        f"{api_url}/billing/credits/spend",
        json={"credits": credits, "description": description},
        headers=auth_headers(access_token),
        timeout=15,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"failed to spend credits: {resp.status_code} {resp.text}")


def auth_headers(access_token: str, include_content_type: bool = True) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {access_token}"}
    if include_content_type:
        headers["Content-Type"] = "application/json"
    return headers


def admin_headers(service_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/json",
    }


def create_project(
    api_url: str,
    access_token: str,
    name: str = "Service Proxy Test",
    model: str = "claude-sonnet-4-5",
) -> str:
    project_id = f"project-{uuid.uuid4().hex[:8]}"
    project_payload = {"id": project_id, "name": name, "model": model}
    resp = requests.post(
        f"{api_url}/projects",
        json=project_payload,
        headers=auth_headers(access_token),
        timeout=20,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"failed to create project: {resp.status_code} {resp.text}")
    return project_id


def create_project_service_key(api_url: str, service_key: str, project_id: str, stub: str) -> str:
    resp = requests.post(
        f"{api_url}/projects/{project_id}/services/{stub}/key",
        headers=admin_headers(service_key),
        timeout=20,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"failed to create project service key: {resp.status_code} {resp.text}")
    data = resp.json()
    service_key = data.get("serviceKey")
    if not service_key:
        raise RuntimeError("missing serviceKey in project service key response")
    return service_key
