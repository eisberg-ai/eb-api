"""Message staging tests (signup + approve user, then chat/staged-builds)."""
from __future__ import annotations

import time
import uuid

import pytest

from test.utils import (
    approve_user,
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


def _create_project(api_url: str, anon_key: str, token: str, project_id: str) -> dict:
    return request_json(
        f'{api_url}/projects',
        method='POST', api_key=anon_key, token=token,
        body={'id': project_id, 'name': 'Test Project', 'model': 'claude-sonnet-4-5'},
    )


def _send_message(
    api_url: str, anon_key: str, token: str,
    project_id: str, message: str, attachments: dict | None = None,
) -> dict:
    body = {'project_id': project_id, 'message': message, 'model': 'claude-sonnet-4-5'}
    if attachments is not None:
        body['attachments'] = attachments
    return request_json(
        f'{api_url}/chat', method='POST', api_key=anon_key, token=token, body=body,
    )


def _get_staged_builds(api_url: str, anon_key: str, token: str, project_id: str) -> dict:
    return request_json(
        f'{api_url}/projects/{project_id}/staged-builds', api_key=anon_key, token=token,
    )


def _delete_staged_build(api_url: str, anon_key: str, token: str, build_id: str) -> None:
    request_json(
        f'{api_url}/builds/{build_id}/staged',
        method='DELETE', api_key=anon_key, token=token,
    )


def _update_build_status(api_url: str, service_key: str, build_id: str, status: str) -> None:
    request_json(
        f'{api_url}/builds/{build_id}',
        method='PATCH', api_key=service_key, token=service_key, body={'status': status},
    )


@pytest.mark.integration
def test_first_message_creates_non_staged_build(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """First message creates a build, not staged."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-first')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-first-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    result = _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    assert result.get('ok') is True
    assert result.get('staged') is None
    assert result.get('build', {}).get('id')


@pytest.mark.integration
def test_follow_up_creates_staged_build(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """Follow-up while build active is staged and depends on first."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-followup')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-followup-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    first = _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    assert first.get('staged') is None
    first_build_id = first['build']['id']
    second = _send_message(api_url, anon_key, user['token'], project_id, 'Add dark mode')
    assert second.get('ok') is True
    assert second.get('staged') is True
    assert second['build']['depends_on_build_id'] == first_build_id
    assert second['build']['status'] == 'pending'


@pytest.mark.integration
def test_max_three_staged_builds(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """At most 3 staged builds; fourth fails with 409."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-max')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-max-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    for msg in ('Add dark mode', 'Add auth', 'Add search'):
        r = _send_message(api_url, anon_key, user['token'], project_id, msg)
        assert r.get('staged') is True
    with pytest.raises(AssertionError) as exc_info:
        request_json(
            f'{api_url}/chat', method='POST', api_key=anon_key, token=user['token'],
            body={'project_id': project_id, 'message': 'Add export', 'model': 'claude-sonnet-4-5'},
        )
    assert '409' in str(exc_info.value) or 'max_staged_builds' in str(exc_info.value).lower()


@pytest.mark.integration
def test_get_staged_builds_returns_ordered(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """GET staged-builds returns list in order."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-get')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-get-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    _send_message(api_url, anon_key, user['token'], project_id, 'Add dark mode')
    _send_message(api_url, anon_key, user['token'], project_id, 'Add auth')
    staged = _get_staged_builds(api_url, anon_key, user['token'], project_id)
    assert len(staged['staged_builds']) == 2
    assert staged['staged_builds'][0]['content'] == 'Add dark mode'
    assert staged['staged_builds'][1]['content'] == 'Add auth'
    assert staged['staged_builds'][0].get('depends_on_build_id')
    assert staged['staged_builds'][1].get('depends_on_build_id')


@pytest.mark.integration
def test_staged_build_promoted_when_dependency_succeeds(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """When dependency build succeeds, staged build is promoted (removed from list)."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-promote')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-promote-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    first = _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    first_build_id = first['build']['id']
    _send_message(api_url, anon_key, user['token'], project_id, 'Add dark mode')
    staged = _get_staged_builds(api_url, anon_key, user['token'], project_id)
    assert len(staged['staged_builds']) == 1
    _update_build_status(api_url, service_key, first_build_id, 'succeeded')
    time.sleep(0.15)
    staged = _get_staged_builds(api_url, anon_key, user['token'], project_id)
    assert len(staged['staged_builds']) == 0


@pytest.mark.integration
def test_delete_staged_build_repairs_chain(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """Deleting middle staged build repairs chain (C depends on A)."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-delete')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-delete-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    first = _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    first_build_id = first['build']['id']
    build_a = _send_message(api_url, anon_key, user['token'], project_id, 'Add dark mode')
    build_b = _send_message(api_url, anon_key, user['token'], project_id, 'Add auth')
    build_c = _send_message(api_url, anon_key, user['token'], project_id, 'Add search')
    assert build_a['build']['depends_on_build_id'] == first_build_id
    assert build_b['build']['depends_on_build_id'] == build_a['build']['id']
    assert build_c['build']['depends_on_build_id'] == build_b['build']['id']
    _delete_staged_build(api_url, anon_key, user['token'], build_b['build']['id'])
    staged = _get_staged_builds(api_url, anon_key, user['token'], project_id)
    assert len(staged['staged_builds']) == 2
    build_c_after = next(b for b in staged['staged_builds'] if b['id'] == build_c['build']['id'])
    assert build_c_after['depends_on_build_id'] == build_a['build']['id']


@pytest.mark.integration
def test_cannot_delete_non_staged_build(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """Deleting a non-staged (active) build via staged endpoint fails."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-delete-active')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-delete-active-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    first = _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    first_build_id = first['build']['id']
    with pytest.raises(AssertionError) as exc_info:
        _delete_staged_build(api_url, anon_key, user['token'], first_build_id)
    assert '400' in str(exc_info.value) or 'can_only_delete_staged' in str(exc_info.value).lower()


@pytest.mark.integration
def test_staged_builds_preserve_attachments(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """Staged build stores attachments; GET returns them."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-attachments')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-attachments-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    attachments = {
        'media': [{'id': 'img1', 'type': 'image', 'url': 'https://example.com/img.png'}],
        'files': [{'id': 'file1', 'filename': 'spec.pdf', 'url': 'https://example.com/spec.pdf'}],
    }
    second = _send_message(
        api_url, anon_key, user['token'], project_id, 'Add these features', attachments,
    )
    assert second.get('staged') is True
    staged = _get_staged_builds(api_url, anon_key, user['token'], project_id)
    assert len(staged['staged_builds']) == 1
    assert staged['staged_builds'][0].get('attachments')
    assert len(staged['staged_builds'][0]['attachments']['media']) == 1
    assert len(staged['staged_builds'][0]['attachments']['files']) == 1


@pytest.mark.integration
def test_failed_build_blocks_new_messages(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """After a build is failed, new messages are rejected."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-failed')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-failed-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    first = _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    _update_build_status(api_url, service_key, first['build']['id'], 'failed')
    time.sleep(0.1)
    with pytest.raises(AssertionError) as exc_info:
        _send_message(api_url, anon_key, user['token'], project_id, 'Add dark mode')
    assert '400' in str(exc_info.value) or 'build_failed' in str(exc_info.value).lower()


@pytest.mark.integration
def test_staged_builds_ordered_by_creation(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """Staged builds returned in creation order."""
    user = sign_up_user(supabase_url, api_url, anon_key, 'staging-order')
    approve_user(api_url, service_key, user['userId'])
    project_id = f'project-staging-order-{uuid.uuid4().hex[:8]}'
    _create_project(api_url, anon_key, user['token'], project_id)
    _send_message(api_url, anon_key, user['token'], project_id, 'Build a todo app')
    _send_message(api_url, anon_key, user['token'], project_id, 'First staged')
    time.sleep(0.06)
    _send_message(api_url, anon_key, user['token'], project_id, 'Second staged')
    time.sleep(0.06)
    _send_message(api_url, anon_key, user['token'], project_id, 'Third staged')
    staged = _get_staged_builds(api_url, anon_key, user['token'], project_id)
    assert len(staged['staged_builds']) == 3
    assert staged['staged_builds'][0]['content'] == 'First staged'
    assert staged['staged_builds'][1]['content'] == 'Second staged'
    assert staged['staged_builds'][2]['content'] == 'Third staged'
