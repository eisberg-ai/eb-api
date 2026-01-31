"""Userland app isolation: schema partition and membership enforcement."""
from __future__ import annotations

import time
import uuid

import pytest
import requests

from test.userland.conftest import request_json, sign_up_user

APP_A_ID = '11111111-1111-1111-1111-111111111111'
APP_B_ID = '22222222-2222-2222-2222-222222222222'


def _wait_for_rest(supabase_url: str, service_key: str, max_attempts: int = 20) -> None:
    """Poll PostgREST until ready (not 503)."""
    url = f'{supabase_url}/rest/v1/app_users?select=app_id&limit=1'
    headers = {'apikey': service_key, 'Authorization': f'Bearer {service_key}'}
    for _ in range(max_attempts):
        resp = requests.get(url, headers=headers, timeout=5)
        if resp.status_code != 503:
            return
        time.sleep(1)
    raise RuntimeError('PostgREST did not become ready in time.')


def _create_app_schema(supabase_url: str, service_key: str, app_id: str) -> None:
    request_json(
        f'{supabase_url}/rest/v1/rpc/create_app_schema',
        method='POST', api_key=service_key, token=service_key,
        body={'app_id': app_id, 'create_items': True},
    )


def _add_member(supabase_url: str, service_key: str, app_id: str, user_id: str) -> None:
    request_json(
        f'{supabase_url}/rest/v1/app_users',
        method='POST', api_key=service_key, token=service_key,
        body={'app_id': app_id, 'user_id': user_id, 'role': 'member'},
    )


@pytest.mark.integration
def test_userland_apps_partitioned_by_schema_and_membership(
    supabase_url: str, api_url: str, anon_key: str, service_key: str,
) -> None:
    """Apps use separate schemas; user sees only apps they are member of."""
    functions_base = f'{supabase_url.rstrip("/")}/functions/v1'
    _wait_for_rest(supabase_url, service_key)
    _create_app_schema(supabase_url, service_key, APP_A_ID)
    _create_app_schema(supabase_url, service_key, APP_B_ID)
    shared_user = sign_up_user(supabase_url, api_url, anon_key, 'userland-shared')
    only_a_user = sign_up_user(supabase_url, api_url, anon_key, 'userland-aonly')
    _add_member(supabase_url, service_key, APP_A_ID, shared_user['userId'])
    _add_member(supabase_url, service_key, APP_B_ID, shared_user['userId'])
    _add_member(supabase_url, service_key, APP_A_ID, only_a_user['userId'])
    suffix = uuid.uuid4().hex[:8]
    label_a = f'from_a_{suffix}'
    label_b = f'from_b_{suffix}'
    insert_a = request_json(
        f'{functions_base}/app_{APP_A_ID}__insertItem',
        method='POST', api_key=anon_key, token=shared_user['token'], body={'label': label_a},
    )
    assert insert_a['item']['label'] == label_a
    insert_b = request_json(
        f'{functions_base}/app_{APP_B_ID}__insertItem',
        method='POST', api_key=anon_key, token=shared_user['token'], body={'label': label_b},
    )
    assert insert_b['item']['label'] == label_b
    list_a = request_json(
        f'{functions_base}/app_{APP_A_ID}__listItems',
        method='POST', api_key=anon_key, token=shared_user['token'],
    )
    labels_a = [it['label'] for it in (list_a.get('items') or [])]
    assert label_a in labels_a
    assert label_b not in labels_a
    list_b = request_json(
        f'{functions_base}/app_{APP_B_ID}__listItems',
        method='POST', api_key=anon_key, token=shared_user['token'],
    )
    labels_b = [it['label'] for it in (list_b.get('items') or [])]
    assert label_b in labels_b
    assert label_a not in labels_b
    forbidden = request_json(
        f'{functions_base}/app_{APP_B_ID}__listItems',
        method='POST', api_key=anon_key, token=only_a_user['token'], expect_status=403,
    )
    assert forbidden.get('error') == 'not_a_member'
