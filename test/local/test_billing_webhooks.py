"""
Local integration tests for Stripe webhook handling and credit ledger idempotency.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timezone

import pytest
import requests

from test.utils import auth_headers, ensure_access_token, resolve_api_url, resolve_env


def decode_jwt_payload(token: str) -> dict:
    parts = token.split(".")
    assert len(parts) >= 2, "invalid JWT: missing payload"
    payload = parts[1].encode("utf-8")
    payload += b"=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def iso_to_unix(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def build_stripe_signature(payload: str, secret: str, timestamp: int | None = None) -> str:
    ts = int(time.time()) if timestamp is None else int(timestamp)
    signed_payload = f"{ts}.{payload}".encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={digest}"


def post_webhook(api_url: str, payload: str, secret: str | None, include_signature: bool = True) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if include_signature and secret:
        headers["stripe-signature"] = build_stripe_signature(payload, secret)
    return requests.post(
        f"{api_url}/billing/webhook",
        data=payload,
        headers=headers,
        timeout=20,
    )


def make_event(event_type: str, data_object: dict, event_id: str | None = None) -> dict:
    return {
        "id": event_id or f"evt_{uuid.uuid4().hex[:10]}",
        "object": "event",
        "type": event_type,
        "api_version": "2023-10-16",
        "created": int(time.time()),
        "livemode": False,
        "data": {"object": data_object},
    }


def get_plan(api_url: str, token: str, plan_key: str) -> dict:
    resp = requests.get(f"{api_url}/billing/plans", headers=auth_headers(token), timeout=15)
    assert resp.status_code == 200, resp.text
    plans = resp.json().get("plans") or []
    for plan in plans:
        if plan.get("key") == plan_key:
            return plan
    raise AssertionError(f"plan {plan_key} not found")


def get_ledger_entries(api_url: str, token: str) -> list[dict]:
    resp = requests.get(f"{api_url}/billing/ledger", headers=auth_headers(token), timeout=15)
    assert resp.status_code == 200, resp.text
    return resp.json().get("entries") or []


@pytest.mark.local
@pytest.mark.integration
def test_billing_webhook_requires_signature() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        pytest.skip("SUPABASE_URL not set.")
    api_url = resolve_api_url(supabase_url, env)
    payload = json.dumps(make_event("ping", {"id": "noop"}), separators=(",", ":"))
    resp = post_webhook(api_url, payload, env.get("STRIPE_WEBHOOK_SECRET"), include_signature=False)
    assert resp.status_code == 400


@pytest.mark.local
@pytest.mark.integration
def test_billing_webhook_subscription_created_idempotent() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    webhook_secret = env.get("STRIPE_WEBHOOK_SECRET")
    if not supabase_url or not service_key or not webhook_secret:
        pytest.skip("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and STRIPE_WEBHOOK_SECRET required.")

    api_url = resolve_api_url(supabase_url, env)
    token = ensure_access_token(service_key, supabase_url)
    user_id = decode_jwt_payload(token).get("sub")
    assert user_id, "access token missing user id"

    plan = get_plan(api_url, token, "plus")
    credits_monthly = float(plan.get("creditsMonthly") or 0)
    assert credits_monthly > 0

    now = int(time.time())
    sub_id = f"sub_{uuid.uuid4().hex[:10]}"
    event_id = f"evt_{uuid.uuid4().hex[:10]}"
    subscription = {
        "id": sub_id,
        "object": "subscription",
        "customer": f"cus_{uuid.uuid4().hex[:10]}",
        "status": "active",
        "current_period_start": now,
        "current_period_end": now + 30 * 24 * 60 * 60,
        "metadata": {"user_id": user_id, "plan_key": "plus"},
        "items": {"data": [{"id": f"si_{uuid.uuid4().hex[:8]}", "price": {"id": "price_plus"}}]},
    }
    payload = json.dumps(make_event("customer.subscription.created", subscription, event_id), separators=(",", ":"))
    resp = post_webhook(api_url, payload, webhook_secret)
    assert resp.status_code == 200, resp.text

    sub_resp = requests.get(f"{api_url}/billing/subscription", headers=auth_headers(token), timeout=15)
    assert sub_resp.status_code == 200, sub_resp.text
    subscription_row = sub_resp.json().get("subscription") or {}
    assert subscription_row.get("plan_key") == "plus"
    assert subscription_row.get("stripe_subscription_id") == sub_id

    entries = [e for e in get_ledger_entries(api_url, token) if e.get("stripe_event_id") == event_id]
    assert len(entries) == 1
    assert abs(float(entries[0].get("credits_delta") or 0) - credits_monthly) <= 0.0001

    resp_repeat = post_webhook(api_url, payload, webhook_secret)
    assert resp_repeat.status_code == 200, resp_repeat.text
    entries_repeat = [e for e in get_ledger_entries(api_url, token) if e.get("stripe_event_id") == event_id]
    assert len(entries_repeat) == 1


@pytest.mark.local
@pytest.mark.integration
def test_billing_webhook_refund_reverses_credits() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    webhook_secret = env.get("STRIPE_WEBHOOK_SECRET")
    if not supabase_url or not service_key or not webhook_secret:
        pytest.skip("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and STRIPE_WEBHOOK_SECRET required.")

    api_url = resolve_api_url(supabase_url, env)
    token = ensure_access_token(service_key, supabase_url)
    user_id = decode_jwt_payload(token).get("sub")
    assert user_id, "access token missing user id"

    credits = 40
    payment_intent_id = f"pi_{uuid.uuid4().hex[:10]}"
    session_id = f"cs_test_{uuid.uuid4().hex[:10]}"
    purchase_event_id = f"evt_{uuid.uuid4().hex[:10]}"
    session = {
        "id": session_id,
        "object": "checkout.session",
        "mode": "payment",
        "metadata": {"user_id": user_id, "pack_key": "starter", "credits": str(credits)},
        "amount_total": credits * 100,
        "currency": "usd",
        "payment_intent": payment_intent_id,
    }
    purchase_payload = json.dumps(
        make_event("checkout.session.completed", session, purchase_event_id),
        separators=(",", ":"),
    )
    purchase_resp = post_webhook(api_url, purchase_payload, webhook_secret)
    assert purchase_resp.status_code == 200, purchase_resp.text

    purchase_entries = [e for e in get_ledger_entries(api_url, token) if e.get("stripe_event_id") == purchase_event_id]
    assert len(purchase_entries) == 1
    assert abs(float(purchase_entries[0].get("credits_delta") or 0) - credits) <= 0.0001

    refund_event_id = f"evt_{uuid.uuid4().hex[:10]}"
    charge = {
        "id": f"ch_{uuid.uuid4().hex[:10]}",
        "object": "charge",
        "payment_intent": payment_intent_id,
        "amount_refunded": credits * 100,
        "currency": "usd",
        "metadata": {"user_id": user_id},
    }
    refund_payload = json.dumps(
        make_event("charge.refunded", charge, refund_event_id),
        separators=(",", ":"),
    )
    refund_resp = post_webhook(api_url, refund_payload, webhook_secret)
    assert refund_resp.status_code == 200, refund_resp.text

    refund_entries = [e for e in get_ledger_entries(api_url, token) if e.get("stripe_event_id") == refund_event_id]
    assert len(refund_entries) == 1
    assert abs(float(refund_entries[0].get("credits_delta") or 0) + credits) <= 0.0001


@pytest.mark.local
@pytest.mark.integration
def test_billing_webhook_subscription_updated_upgrade_credits() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    webhook_secret = env.get("STRIPE_WEBHOOK_SECRET")
    if not supabase_url or not service_key or not webhook_secret:
        pytest.skip("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and STRIPE_WEBHOOK_SECRET required.")

    api_url = resolve_api_url(supabase_url, env)
    token = ensure_access_token(service_key, supabase_url)
    user_id = decode_jwt_payload(token).get("sub")
    assert user_id, "access token missing user id"

    plan_plus = get_plan(api_url, token, "plus")
    plan_pro = get_plan(api_url, token, "pro")
    credits_plus = float(plan_plus.get("creditsMonthly") or 0)
    credits_pro = float(plan_pro.get("creditsMonthly") or 0)
    assert credits_pro > credits_plus

    now = int(time.time())
    sub_id = f"sub_{uuid.uuid4().hex[:10]}"
    created_event_id = f"evt_{uuid.uuid4().hex[:10]}"
    base_subscription = {
        "id": sub_id,
        "object": "subscription",
        "customer": f"cus_{uuid.uuid4().hex[:10]}",
        "status": "active",
        "current_period_start": now,
        "current_period_end": now + 30 * 24 * 60 * 60,
        "items": {"data": [{"id": f"si_{uuid.uuid4().hex[:8]}", "price": {"id": "price_plus"}}]},
    }
    created_payload = json.dumps(
        make_event(
            "customer.subscription.created",
            {**base_subscription, "metadata": {"user_id": user_id, "plan_key": "plus"}},
            created_event_id,
        ),
        separators=(",", ":"),
    )
    created_resp = post_webhook(api_url, created_payload, webhook_secret)
    assert created_resp.status_code == 200, created_resp.text

    updated_event_id = f"evt_{uuid.uuid4().hex[:10]}"
    updated_payload = json.dumps(
        make_event(
            "customer.subscription.updated",
            {**base_subscription, "metadata": {"user_id": user_id, "plan_key": "pro"}},
            updated_event_id,
        ),
        separators=(",", ":"),
    )
    updated_resp = post_webhook(api_url, updated_payload, webhook_secret)
    assert updated_resp.status_code == 200, updated_resp.text

    updated_entries = [e for e in get_ledger_entries(api_url, token) if e.get("stripe_event_id") == updated_event_id]
    assert len(updated_entries) == 1
    expected_diff = credits_pro - credits_plus
    assert abs(float(updated_entries[0].get("credits_delta") or 0) - expected_diff) <= 0.0001

    repeat_resp = post_webhook(api_url, updated_payload, webhook_secret)
    assert repeat_resp.status_code == 200, repeat_resp.text
    repeat_entries = [e for e in get_ledger_entries(api_url, token) if e.get("stripe_event_id") == updated_event_id]
    assert len(repeat_entries) == 1

    sub_resp = requests.get(f"{api_url}/billing/subscription", headers=auth_headers(token), timeout=15)
    assert sub_resp.status_code == 200, sub_resp.text
    subscription_row = sub_resp.json().get("subscription") or {}
    assert subscription_row.get("plan_key") == "pro"


@pytest.mark.local
@pytest.mark.integration
def test_billing_webhook_subscription_deleted_marks_canceled() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    webhook_secret = env.get("STRIPE_WEBHOOK_SECRET")
    if not supabase_url or not service_key or not webhook_secret:
        pytest.skip("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and STRIPE_WEBHOOK_SECRET required.")

    api_url = resolve_api_url(supabase_url, env)
    token = ensure_access_token(service_key, supabase_url)
    user_id = decode_jwt_payload(token).get("sub")
    assert user_id, "access token missing user id"

    now = int(time.time())
    sub_id = f"sub_{uuid.uuid4().hex[:10]}"
    created_event_id = f"evt_{uuid.uuid4().hex[:10]}"
    subscription = {
        "id": sub_id,
        "object": "subscription",
        "customer": f"cus_{uuid.uuid4().hex[:10]}",
        "status": "active",
        "current_period_start": now,
        "current_period_end": now + 30 * 24 * 60 * 60,
        "metadata": {"user_id": user_id, "plan_key": "plus"},
        "items": {"data": [{"id": f"si_{uuid.uuid4().hex[:8]}", "price": {"id": "price_plus"}}]},
    }
    created_payload = json.dumps(
        make_event("customer.subscription.created", subscription, created_event_id),
        separators=(",", ":"),
    )
    created_resp = post_webhook(api_url, created_payload, webhook_secret)
    assert created_resp.status_code == 200, created_resp.text

    deleted_event_id = f"evt_{uuid.uuid4().hex[:10]}"
    deleted_payload = json.dumps(
        make_event("customer.subscription.deleted", subscription, deleted_event_id),
        separators=(",", ":"),
    )
    deleted_resp = post_webhook(api_url, deleted_payload, webhook_secret)
    assert deleted_resp.status_code == 200, deleted_resp.text

    sub_resp = requests.get(f"{api_url}/billing/subscription", headers=auth_headers(token), timeout=15)
    assert sub_resp.status_code == 200, sub_resp.text
    subscription_row = sub_resp.json().get("subscription") or {}
    assert subscription_row.get("status") == "canceled"


@pytest.mark.local
@pytest.mark.integration
def test_billing_webhook_invoice_payment_succeeded_renewal() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    webhook_secret = env.get("STRIPE_WEBHOOK_SECRET")
    if not supabase_url or not service_key or not webhook_secret:
        pytest.skip("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and STRIPE_WEBHOOK_SECRET required.")

    api_url = resolve_api_url(supabase_url, env)
    token = ensure_access_token(service_key, supabase_url)
    user_id = decode_jwt_payload(token).get("sub")
    assert user_id, "access token missing user id"

    plan_plus = get_plan(api_url, token, "plus")
    credits_monthly = float(plan_plus.get("creditsMonthly") or 0)
    assert credits_monthly > 0

    now = int(time.time())
    sub_id = f"sub_{uuid.uuid4().hex[:10]}"
    created_event_id = f"evt_{uuid.uuid4().hex[:10]}"
    subscription = {
        "id": sub_id,
        "object": "subscription",
        "customer": f"cus_{uuid.uuid4().hex[:10]}",
        "status": "active",
        "current_period_start": now,
        "current_period_end": now + 30 * 24 * 60 * 60,
        "metadata": {"user_id": user_id, "plan_key": "plus"},
        "items": {"data": [{"id": f"si_{uuid.uuid4().hex[:8]}", "price": {"id": "price_plus"}}]},
    }
    created_payload = json.dumps(
        make_event("customer.subscription.created", subscription, created_event_id),
        separators=(",", ":"),
    )
    created_resp = post_webhook(api_url, created_payload, webhook_secret)
    assert created_resp.status_code == 200, created_resp.text

    sub_resp = requests.get(f"{api_url}/billing/subscription", headers=auth_headers(token), timeout=15)
    assert sub_resp.status_code == 200, sub_resp.text
    subscription_row = sub_resp.json().get("subscription") or {}
    period_start = subscription_row.get("current_period_start")
    period_end = subscription_row.get("current_period_end")
    assert period_start and period_end

    invoice_event_id = f"evt_{uuid.uuid4().hex[:10]}"
    invoice = {
        "id": f"in_{uuid.uuid4().hex[:10]}",
        "object": "invoice",
        "subscription": sub_id,
        "period_start": iso_to_unix(period_start),
        "period_end": iso_to_unix(period_end),
    }
    invoice_payload = json.dumps(
        make_event("invoice.payment_succeeded", invoice, invoice_event_id),
        separators=(",", ":"),
    )
    invoice_resp = post_webhook(api_url, invoice_payload, webhook_secret)
    assert invoice_resp.status_code == 200, invoice_resp.text

    invoice_entries = [e for e in get_ledger_entries(api_url, token) if e.get("stripe_event_id") == invoice_event_id]
    assert len(invoice_entries) == 1
    assert abs(float(invoice_entries[0].get("credits_delta") or 0) - credits_monthly) <= 0.0001
