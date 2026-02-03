"""Invite, promo, and waitlist gate tests (signup-based flows)."""
from __future__ import annotations

import pytest

from test.utils import (
    request_json,
    resolve_api_url,
    resolve_env,
    sign_up_user,
)


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


@pytest.mark.integration
def test_non_admin_invite_sets_join_method(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """Non-admin user creates invite; invitee redeems; profile shows invite join method."""
    inviter = sign_up_user(supabase_url, api_url, anon_key, 'inviter')
    invite = request_json(
        f'{api_url}/invites', method='POST', api_key=anon_key, token=inviter['token'],
    )
    assert invite.get('code'), 'invite code should be returned'
    invitee = sign_up_user(supabase_url, api_url, anon_key, 'invitee')
    request_json(
        f'{api_url}/auth/invite',
        method='POST', api_key=anon_key, token=invitee['token'], body={'code': invite['code']},
    )
    profile = request_json(
        f'{api_url}/users/profile', api_key=anon_key, token=invitee['token'],
    )
    assert profile.get('joinMethod') == 'invite'
    assert profile.get('joinCode') == invite['code']


@pytest.mark.integration
def test_promo_redemption_marks_join_method(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """Admin creates promo; user redeems; profile shows promo join method."""
    promo = request_json(
        f'{api_url}/admin/promo-codes',
        method='POST', api_key=service_key, token=service_key, body={'amount': 5},
    )
    assert promo.get('code'), 'promo code should be returned'
    user = sign_up_user(supabase_url, api_url, anon_key, 'promo')
    request_json(
        f'{api_url}/billing/promo',
        method='POST', api_key=anon_key, token=user['token'], body={'code': promo['code']},
    )
    profile = request_json(
        f'{api_url}/users/profile', api_key=anon_key, token=user['token'],
    )
    assert profile.get('joinMethod') == 'promo'
    assert profile.get('joinCode') == promo['code']


@pytest.mark.integration
def test_waitlist_gate_enforces_approval_denial(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """Approved user passes waitlist gate; denied user gets 403."""
    approved_user = sign_up_user(supabase_url, api_url, anon_key, 'approved')
    request_json(
        f'{api_url}/admin/users/{approved_user["userId"]}/approval',
        method='POST', api_key=service_key, token=service_key, body={'status': 'approved'},
    )
    approved_gate = request_json(
        f'{api_url}/auth/waitlist', api_key=anon_key, token=approved_user['token'],
    )
    assert approved_gate.get('allowed') is True
    assert approved_gate.get('accessStatus') == 'approved'
    denied_user = sign_up_user(supabase_url, api_url, anon_key, 'denied')
    request_json(
        f'{api_url}/admin/users/{denied_user["userId"]}/approval',
        method='POST', api_key=service_key, token=service_key, body={'status': 'denied'},
    )
    denied_gate = request_json(
        f'{api_url}/auth/waitlist',
        api_key=anon_key, token=denied_user['token'], expect_status=403,
    )
    assert denied_gate.get('allowed') is False
    assert denied_gate.get('accessStatus') == 'denied'
