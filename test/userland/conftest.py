"""Shared fixtures and helpers for userland API tests (auth/signup-based)."""
from __future__ import annotations

import uuid

import pytest
import requests

from test.utils import resolve_api_url, resolve_env

DEFAULT_PASSWORD = 'TestPassword123!'


@pytest.fixture(scope='module')
def env() -> dict[str, str]:
    return resolve_env()


@pytest.fixture(scope='module')
def supabase_url(env: dict[str, str]) -> str:
    return (env.get('SUPABASE_URL') or 'http://127.0.0.1:54321').rstrip('/')


@pytest.fixture(scope='module')
def api_url(supabase_url: str, env: dict[str, str]) -> str:
    return resolve_api_url(supabase_url, env)


@pytest.fixture(scope='module')
def anon_key(env: dict[str, str]) -> str:
    key = env.get('SUPABASE_ANON_KEY')
    if not key:
        pytest.skip('SUPABASE_ANON_KEY required for userland tests')
    return key


@pytest.fixture(scope='module')
def service_key(env: dict[str, str]) -> str:
    key = env.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY required for userland tests')
    return key


def request_json(
    url: str,
    *,
    method: str = 'GET',
    token: str | None = None,
    api_key: str | None = None,
    body: dict | None = None,
    expect_status: int | None = None,
) -> dict:
    """Perform HTTP request and return JSON; assert status if expect_status set."""
    headers = {'Content-Type': 'application/json'}
    if api_key:
        headers['apikey'] = api_key
    if token:
        headers['Authorization'] = f'Bearer {token}'
    resp = requests.request(
        method, url, headers=headers, json=body, timeout=15,
    )
    data = resp.json() if resp.content else {}
    expected = expect_status if expect_status is not None else (resp.status_code if resp.ok else None)
    if expected is not None and resp.status_code != expected:
        raise AssertionError(f'request failed ({resp.status_code}) for {url}: {data}')
    if not resp.ok and expected is None:
        raise AssertionError(f'request failed ({resp.status_code}) for {url}: {data}')
    return data


def unique_email(prefix: str) -> str:
    return f'{prefix}-{uuid.uuid4().hex[:8]}@example.com'


def sign_up_user(
    supabase_url: str,
    api_url: str,
    anon_key: str,
    prefix: str,
) -> dict:
    """Sign up via auth/v1/signup; returns dict with email, userId, token."""
    email = unique_email(prefix)
    payload = {'email': email, 'password': DEFAULT_PASSWORD}
    data = request_json(
        f'{supabase_url}/auth/v1/signup',
        method='POST', api_key=anon_key, body=payload,
    )
    token = data.get('access_token') or (data.get('session') or {}).get('access_token')
    user_id = (data.get('user') or {}).get('id') or (data.get('session') or {}).get('user', {}).get('id')
    assert token, 'signup should return access token'
    assert user_id, 'signup should return user id'
    return {'email': email, 'userId': user_id, 'token': token}


def approve_user(api_url: str, service_key: str, user_id: str) -> None:
    """Set user approval status to approved via admin endpoint."""
    request_json(
        f'{api_url}/admin/users/{user_id}/approval',
        method='POST', api_key=service_key, token=service_key, body={'status': 'approved'},
    )
