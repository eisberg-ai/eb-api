"""
integration tests for message staging feature.
"""
from __future__ import annotations

import time
import uuid

import pytest
import requests

from test.utils import ensure_access_token, resolve_api_url, resolve_env


def resolve_test_auth() -> tuple[str, str, str]:
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set")
    supabase_url = env.get("SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
    api_url = resolve_api_url(supabase_url, env)
    access_token = ensure_access_token(service_key, supabase_url)
    return api_url, access_token, service_key


@pytest.mark.integration
def test_staged_build_creation() -> None:
    """
    test that follow-up messages create staged builds.
    """
    api_url, access_token = resolve_test_auth()
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
    api_url, access_token = resolve_test_auth()
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
    api_url, access_token = resolve_test_auth()
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
    api_url, access_token = resolve_test_auth()
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
    api_url, access_token, service_key = resolve_test_auth()
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
    api_url, access_token, service_key = resolve_test_auth()
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


@pytest.mark.integration
def test_edit_staged_build_updates_content() -> None:
    """
    test editing a staged build updates its content.
    """
    api_url, access_token = resolve_test_auth()
    project_id = f'project-edit-staging-{uuid.uuid4().hex[:8]}'
    # first message
    requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'build a todo app', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    # staged message
    staged_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'add dark mode', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    staged_build_id = staged_resp.json()['build']['id']
    update_resp = requests.patch(
        f'{api_url}/builds/{staged_build_id}/staged',
        json={'content': 'add a light theme instead'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert update_resp.status_code == 200, update_resp.text
    # verify staged build content updated
    staged_list = requests.get(
        f'{api_url}/projects/{project_id}/staged-builds',
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert staged_list.status_code == 200, staged_list.text
    staged_builds = staged_list.json()['staged_builds']
    assert len(staged_builds) == 1
    assert staged_builds[0]['content'] == 'add a light theme instead'


@pytest.mark.integration
def test_edit_staged_build_locked_after_promotion() -> None:
    """
    test editing a staged build fails once it starts processing.
    """
    api_url, access_token, service_key = resolve_test_auth()
    project_id = f'project-edit-locked-{uuid.uuid4().hex[:8]}'
    # first message
    first_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'build a todo app', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    first_build_id = first_resp.json()['build']['id']
    # staged message
    staged_resp = requests.post(
        f'{api_url}/chat',
        json={'project_id': project_id, 'message': 'add dark mode', 'model': 'claude-sonnet-4-5'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    staged_build_id = staged_resp.json()['build']['id']
    # promote staged build by completing first build
    promote_resp = requests.patch(
        f'{api_url}/builds/{first_build_id}',
        json={'status': 'succeeded'},
        headers={'Authorization': f'Bearer {service_key}'},
        timeout=15,
    )
    assert promote_resp.status_code == 200, promote_resp.text
    time.sleep(0.2)
    update_resp = requests.patch(
        f'{api_url}/builds/{staged_build_id}/staged',
        json={'content': 'add new onboarding'},
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
    )
    assert update_resp.status_code == 409, update_resp.text
    data = update_resp.json()
    assert data.get('error') == 'staged_locked'
