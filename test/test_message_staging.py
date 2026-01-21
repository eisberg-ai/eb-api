"""
integration tests for message staging feature.
"""
from __future__ import annotations

import os
import time
import uuid

import pytest
import requests


def get_api_url() -> str:
    """get api url from environment."""
    supabase_url = os.getenv('SUPABASE_URL', 'http://127.0.0.1:54321').rstrip('/')
    return os.getenv('API_URL') or f'{supabase_url}/functions/v1/api'


def get_service_key() -> str | None:
    """get supabase service role key from environment."""
    return os.getenv('SUPABASE_SERVICE_ROLE_KEY')


def create_test_user(api_url: str, service_key: str) -> str:
    """
    create a test user and return access token.
    uses admin generate_link to bypass email confirmation.
    """
    email = f'test-staging-{uuid.uuid4().hex[:8]}@local.test'
    password = f'TestPass{uuid.uuid4().hex[:8]}!'
    supabase_url = os.getenv('SUPABASE_URL', 'http://127.0.0.1:54321').rstrip('/')
    auth_url = f'{supabase_url}/auth/v1'
    admin_url = f'{auth_url}/admin/generate_link'
    resp = requests.post(
        admin_url,
        json={'type': 'signup', 'email': email, 'password': password},
        headers={
            'Authorization': f'Bearer {service_key}',
            'apikey': service_key,
            'Content-Type': 'application/json',
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(f'failed to create test user: {resp.text}')
    data = resp.json()
    # extract access token from action link
    action_link = data.get('properties', {}).get('action_link', '')
    if 'access_token=' not in action_link:
        raise RuntimeError('no access token in action link')
    token_part = action_link.split('access_token=')[1].split('&')[0]
    return token_part


@pytest.mark.integration
def test_staged_build_creation() -> None:
    """
    test that follow-up messages create staged builds.
    """
    service_key = get_service_key()
    if not service_key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY not set')
    api_url = get_api_url()
    access_token = create_test_user(api_url, service_key)
    project_id = f'project-staging-{uuid.uuid4().hex[:8]}'
    # first message (non-staged)
    first_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'build a todo app', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert first_resp.status_code == 200, first_resp.text
    first_data = first_resp.json()
    assert first_data.get('ok') is True
    assert first_data.get('staged') is None
    first_build_id = first_data['build']['id']
    # second message (should be staged)
    second_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'add dark mode', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert second_resp.status_code == 200, second_resp.text
    second_data = second_resp.json()
    assert second_data.get('ok') is True
    assert second_data.get('staged') is True, 'follow-up should be staged'
    assert second_data['build']['status'] == 'pending'
    assert second_data['build']['depends_on_build_id'] == first_build_id


@pytest.mark.integration
def test_max_staged_builds_limit() -> None:
    """
    test that max 3 staged builds can be queued.
    """
    service_key = get_service_key()
    if not service_key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY not set')
    api_url = get_api_url()
    access_token = create_test_user(api_url, service_key)
    project_id = f'project-max-staging-{uuid.uuid4().hex[:8]}'
    # first message
    requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'build a todo app', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    # add 3 staged builds
    for i in range(3):
        resp = requests.post(
            f'{api_url}/chat',
            json={'project_id': project_id, 'message': f'feature {i}', 'model': 'claude-sonnet-4-5'},
            headers={'Authorization': f'Bearer {access_token}'},
            timeout=15,
        )
        assert resp.status_code == 200, f'staged build {i} failed: {resp.text}'
        assert resp.json().get('staged') is True
    # fourth should fail
    resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'feature 3', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert resp.status_code == 409, 'should reject 4th staged build'
    data = resp.json()
    assert data.get('error') == 'max_staged_builds'


@pytest.mark.integration
def test_get_staged_builds() -> None:
    """
    test fetching staged builds for a project.
    """
    service_key = get_service_key()
    if not service_key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY not set')
    api_url = get_api_url()
    access_token = create_test_user(api_url, service_key)
    project_id = f'project-get-staging-{uuid.uuid4().hex[:8]}'
    # first message
    requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'build a todo app', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    # add 2 staged builds
    requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'add dark mode', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'add auth', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    # fetch staged builds
    resp = requests.get(
        f'{api_url}/projects/{project_id}/staged-builds',
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert len(data['staged_builds']) == 2
    assert data['staged_builds'][0]['content'] == 'add dark mode'
    assert data['staged_builds'][1]['content'] == 'add auth'
    assert data['staged_builds'][0]['depends_on_build_id'] is not None


@pytest.mark.integration
def test_delete_staged_build_with_chain_repair() -> None:
    """
    test deleting a staged build repairs the dependency chain.
    """
    service_key = get_service_key()
    if not service_key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY not set')
    api_url = get_api_url()
    access_token = create_test_user(api_url, service_key)
    project_id = f'project-delete-staging-{uuid.uuid4().hex[:8]}'
    # first message
    first_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'build a todo app', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    first_build_id = first_resp.json()['build']['id']
    # add 3 staged builds: A -> B -> C
    build_a_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'feature a', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    build_a_id = build_a_resp.json()['build']['id']
    build_b_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'feature b', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    build_b_id = build_b_resp.json()['build']['id']
    build_c_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'feature c', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    build_c_id = build_c_resp.json()['build']['id']
    # verify dependencies before deletion
    assert build_a_resp.json()['build']['depends_on_build_id'] == first_build_id
    assert build_b_resp.json()['build']['depends_on_build_id'] == build_a_id
    assert build_c_resp.json()['build']['depends_on_build_id'] == build_b_id
    # delete buildB
    delete_resp = requests.delete(
        f'{api_url}/builds/{build_b_id}/staged',
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert delete_resp.status_code == 200, delete_resp.text
    # verify chain repair: C should now depend on A
    staged_resp = requests.get(
        f'{api_url}/projects/{project_id}/staged-builds',
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    staged_builds = staged_resp.json()['staged_builds']
    assert len(staged_builds) == 2, 'should have 2 staged builds left'
    build_c_after = next(b for b in staged_builds if b['id'] == build_c_id)
    assert build_c_after['depends_on_build_id'] == build_a_id, 'buildC should depend on buildA'


@pytest.mark.integration
def test_build_promotion_on_success() -> None:
    """
    test that staged builds are promoted when dependency succeeds.
    """
    service_key = get_service_key()
    if not service_key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY not set')
    api_url = get_api_url()
    access_token = create_test_user(api_url, service_key)
    project_id = f'project-promote-staging-{uuid.uuid4().hex[:8]}'
    # first message
    first_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'build a todo app', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    first_build_id = first_resp.json()['build']['id']
    # add staged build
    second_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'add dark mode', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert second_resp.json().get('staged') is True
    # verify staged build exists
    staged_resp = requests.get(
        f'{api_url}/projects/{project_id}/staged-builds',
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert len(staged_resp.json()['staged_builds']) == 1
    # mark first build as succeeded (using service key)
    update_resp = requests.patch(
        f'{api_url}/builds/{first_build_id}',
        json={'status': 'succeeded'},
        headers={'Authorization': f'Bearer {service_key}'},
        timeout=15,
    )
    assert update_resp.status_code == 200, update_resp.text
    # wait for promotion
    time.sleep(0.2)
    # verify staged build was promoted (should be gone from staged list)
    staged_after = requests.get(
        f'{api_url}/projects/{project_id}/staged-builds',
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert len(staged_after.json()['staged_builds']) == 0, 'staged build should be promoted'


@pytest.mark.integration
def test_failed_build_blocks_new_messages() -> None:
    """
    test that a failed build blocks new messages.
    """
    service_key = get_service_key()
    if not service_key:
        pytest.skip('SUPABASE_SERVICE_ROLE_KEY not set')
    api_url = get_api_url()
    access_token = create_test_user(api_url, service_key)
    project_id = f'project-failed-staging-{uuid.uuid4().hex[:8]}'
    # create and fail a build
    first_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'build a todo app', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    first_build_id = first_resp.json()['build']['id']
    # mark as failed
    requests.patch(
        f'{api_url}/builds/{first_build_id}',
        json={'status': 'failed', 'error_code': 'test_error'},
        headers={'Authorization': f'Bearer {service_key}'},
        timeout=15,
    )
    time.sleep(0.1)
    # try to send another message (should fail)
    resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'add dark mode', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert resp.status_code == 400, 'should block new messages after failed build'
    data = resp.json()
    assert data.get('error') == 'build_failed'
