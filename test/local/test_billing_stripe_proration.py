"""
Integration tests for Stripe subscription proration.

Requires local Supabase + Stripe test mode keys.
"""
from __future__ import annotations

import base64
import json
import os
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
import requests

from test.utils import (
    auth_headers,
    ensure_access_token,
    load_env_file,
    resolve_api_url,
    resolve_env,
)

STRIPE_API_BASE = "https://api.stripe.com"


def get_eb_api_env() -> dict[str, str]:
    env = dict(os.environ)
    if env.get("EB_API_SUPABASE_URL") and env.get("EB_API_SERVICE_ROLE_KEY"):
        return {
            "SUPABASE_URL": env["EB_API_SUPABASE_URL"].rstrip("/"),
            "SUPABASE_SERVICE_ROLE_KEY": env["EB_API_SERVICE_ROLE_KEY"],
        }
    root = Path(__file__).resolve().parents[2]
    local_env = load_env_file(root / ".env.local")
    supabase_url = (
        env.get("EB_API_SUPABASE_URL")
        or local_env.get("SUPABASE_URL")
        or env.get("SUPABASE_URL")
        or "http://127.0.0.1:54321"
    ).rstrip("/")
    service_key = (
        env.get("EB_API_SERVICE_ROLE_KEY")
        or local_env.get("SUPABASE_SERVICE_ROLE_KEY")
        or env.get("SUPABASE_SERVICE_ROLE_KEY")
        or ""
    )
    return {
        "SUPABASE_URL": supabase_url,
        "SUPABASE_SERVICE_ROLE_KEY": service_key,
    }


def stripe_request(
    method: str,
    path: str,
    stripe_key: str,
    *,
    data: dict | list | None = None,
    params: dict | list | None = None,
    timeout: int = 30,
) -> dict:
    url = f"{STRIPE_API_BASE}{path}"
    resp = requests.request(
        method,
        url,
        auth=(stripe_key, ""),
        data=data,
        params=params,
        timeout=timeout,
    )
    assert resp.status_code < 400, f"stripe {method} {path} failed: {resp.status_code} {resp.text}"
    return resp.json()


def decode_jwt_payload(token: str) -> dict:
    parts = token.split(".")
    assert len(parts) >= 2, "invalid JWT: missing payload"
    payload = parts[1].encode("utf-8")
    payload += b"=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def unix_to_iso(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, tz=UTC).isoformat().replace("+00:00", "Z")


def supabase_upsert(env: dict[str, str], table: str, rows: list[dict], on_conflict: str) -> None:
    supabase_url = (env.get("SUPABASE_URL") or "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    assert supabase_url and service_key, "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"
    url = f"{supabase_url}/rest/v1/{table}?on_conflict={on_conflict}"
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }
    resp = requests.post(url, headers=headers, json=rows, timeout=15)
    assert resp.status_code in (200, 201, 204), f"supabase upsert {table} failed: {resp.status_code} {resp.text}"


def get_price_amount(stripe_key: str, price_id: str) -> int:
    price = stripe_request("GET", f"/v1/prices/{price_id}", stripe_key)
    amount = price.get("unit_amount")
    interval = (price.get("recurring") or {}).get("interval")
    assert amount is not None, f"price {price_id} missing unit_amount"
    assert interval == "month", f"price {price_id} must be monthly, got {interval}"
    return int(amount)


def create_test_clock(stripe_key: str) -> dict:
    now = int(time.time())
    return stripe_request(
        "POST",
        "/v1/test_helpers/test_clocks",
        stripe_key,
        data={"frozen_time": str(now)},
    )


def advance_test_clock(stripe_key: str, clock_id: str, target_time: int) -> None:
    stripe_request(
        "POST",
        f"/v1/test_helpers/test_clocks/{clock_id}/advance",
        stripe_key,
        data={"frozen_time": str(target_time)},
    )
    deadline = time.time() + 45
    while time.time() < deadline:
        clock = stripe_request("GET", f"/v1/test_helpers/test_clocks/{clock_id}", stripe_key)
        if clock.get("status") == "ready" and int(clock.get("frozen_time", 0)) == target_time:
            return
        time.sleep(1)
    raise AssertionError("test clock did not advance to target time")


def is_proration_line(line: dict) -> bool:
    if line.get("proration") is True or line.get("proration_details"):
        return True
    description = (line.get("description") or "").lower()
    return "unused time" in description or "remaining time" in description


def get_proration_preview(
    stripe_key: str,
    *,
    customer_id: str,
    subscription_id: str,
    subscription_item_id: str,
    new_price_id: str,
    proration_time: int,
) -> tuple[dict, list[dict]]:
    preview = stripe_request(
        "POST",
        "/v1/invoices/create_preview",
        stripe_key,
        data={
            "customer": customer_id,
            "subscription": subscription_id,
            "subscription_details[items][0][id]": subscription_item_id,
            "subscription_details[items][0][price]": new_price_id,
            "subscription_details[proration_behavior]": "create_prorations",
            "subscription_details[proration_date]": str(proration_time),
        },
    )
    lines = (preview.get("lines") or {}).get("data") or []
    proration_lines = [line for line in lines if is_proration_line(line)]
    if not proration_lines:
        raise AssertionError("proration preview not found")
    return preview, proration_lines


def expected_proration_cents(
    old_amount: int,
    new_amount: int,
    period_start: int,
    period_end: int,
    proration_time: int,
) -> tuple[int, float]:
    duration = period_end - period_start
    assert duration > 0, "subscription period duration must be > 0"
    remaining = period_end - proration_time
    assert 0 <= remaining <= duration, "proration time must be within billing period"
    fraction = remaining / duration
    diff = new_amount - old_amount
    return int(round(diff * fraction)), fraction


def sum_proration_by_price(
    proration_lines: list[dict],
    *,
    label_map: dict[str, str] | None = None,
) -> dict[str, int]:
    totals: dict[str, int] = {}
    for line in proration_lines:
        price = line.get("price") or {}
        plan = line.get("plan") or {}
        price_id = price.get("id") or plan.get("id")
        if not price_id and label_map:
            description = (line.get("description") or "").lower()
            for label, mapped_price in label_map.items():
                if label.lower() in description:
                    price_id = mapped_price
                    break
        if not price_id:
            continue
        totals[price_id] = totals.get(price_id, 0) + int(line.get("amount") or 0)
    return totals


def run_proration_case(
    *,
    env: dict[str, str],
    api_url: str,
    stripe_key: str,
    access_token: str,
    user_id: str,
    email: str,
    old_plan_key: str,
    new_plan_key: str,
    old_price_id: str,
    new_price_id: str,
    old_amount: int,
    new_amount: int,
    remaining_fraction: float,
) -> dict:
    clock = create_test_clock(stripe_key)
    customer = stripe_request(
        "POST",
        "/v1/customers",
        stripe_key,
        data={
            "email": email,
            "test_clock": clock["id"],
            "metadata[user_id]": user_id,
        },
    )
    payment_method = stripe_request(
        "POST",
        "/v1/payment_methods",
        stripe_key,
        data={
            "type": "card",
            "card[token]": "tok_visa",
        },
    )
    stripe_request(
        "POST",
        f"/v1/payment_methods/{payment_method['id']}/attach",
        stripe_key,
        data={"customer": customer["id"]},
    )
    stripe_request(
        "POST",
        f"/v1/customers/{customer['id']}",
        stripe_key,
        data={"invoice_settings[default_payment_method]": payment_method["id"]},
    )
    subscription = stripe_request(
        "POST",
        "/v1/subscriptions",
        stripe_key,
        data={
            "customer": customer["id"],
            "items[0][price]": old_price_id,
            "metadata[user_id]": user_id,
            "metadata[plan_key]": old_plan_key,
        },
    )
    items = (subscription.get("items") or {}).get("data") or []
    item = items[0] if items else {}
    subscription_item_id = item.get("id")
    period_start = int(item.get("current_period_start") or subscription.get("current_period_start") or 0)
    period_end = int(item.get("current_period_end") or subscription.get("current_period_end") or 0)
    duration = period_end - period_start
    assert duration > 0, "subscription period duration must be > 0"
    assert subscription_item_id, "subscription item id missing"
    remaining_seconds = max(1, int(round(duration * remaining_fraction)))
    proration_time = period_end - remaining_seconds
    if proration_time < period_start:
        proration_time = period_start

    supabase_upsert(
        env,
        "stripe_customers",
        [{"user_id": user_id, "customer_id": customer["id"]}],
        "user_id",
    )
    supabase_upsert(
        env,
        "user_subscriptions",
        [
            {
                "user_id": user_id,
                "plan_key": old_plan_key,
                "stripe_subscription_id": subscription["id"],
                "stripe_customer_id": customer["id"],
                "status": subscription["status"],
                "current_period_start": unix_to_iso(period_start),
                "current_period_end": unix_to_iso(period_end),
                "credits_allocated_this_period": 0,
                "updated_at": unix_to_iso(int(time.time())),
            }
        ],
        "user_id",
    )

    if proration_time != period_start:
        advance_test_clock(stripe_key, clock["id"], proration_time)

    preview, proration_lines = get_proration_preview(
        stripe_key,
        customer_id=customer["id"],
        subscription_id=subscription["id"],
        subscription_item_id=subscription_item_id,
        new_price_id=new_price_id,
        proration_time=proration_time,
    )

    resp = requests.post(
        f"{api_url}/billing/subscription-checkout",
        headers=auth_headers(access_token),
        json={"planKey": new_plan_key},
        timeout=20,
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload.get("updated") is True, payload

    updated_subscription = stripe_request(
        "GET",
        f"/v1/subscriptions/{subscription['id']}",
        stripe_key,
    )
    updated_items = (updated_subscription.get("items") or {}).get("data") or []
    updated_item = updated_items[0] if updated_items else {}
    updated_price_id = (updated_item.get("price") or {}).get("id")
    assert updated_price_id == new_price_id, "subscription price not updated"
    proration_total = sum(int(line.get("amount") or 0) for line in proration_lines)
    expected_total, fraction = expected_proration_cents(
        old_amount,
        new_amount,
        period_start,
        period_end,
        proration_time,
    )
    return {
        "invoice": preview,
        "proration_lines": proration_lines,
        "proration_total": proration_total,
        "expected_total": expected_total,
        "fraction": fraction,
        "period_start": period_start,
        "period_end": period_end,
        "proration_time": proration_time,
        "old_price_id": old_price_id,
        "new_price_id": new_price_id,
        "old_amount": old_amount,
        "new_amount": new_amount,
    }


@pytest.mark.local
@pytest.mark.integration
@pytest.mark.slow
@pytest.mark.parametrize(
    "old_plan_key,new_plan_key,remaining_fraction",
    [
        ("plus", "pro", 0.5),
        ("pro", "plus", 0.5),
        ("plus", "pro", 0.1),
    ],
)
def test_stripe_subscription_proration(
    old_plan_key: str,
    new_plan_key: str,
    remaining_fraction: float,
) -> None:
    env = resolve_env()
    eb_api_env = get_eb_api_env()
    supabase_url = eb_api_env.get("SUPABASE_URL", "").rstrip("/")
    service_key = eb_api_env.get("SUPABASE_SERVICE_ROLE_KEY")
    stripe_key = env.get("STRIPE_SECRET_KEY")
    price_plus = env.get("STRIPE_PRICE_PLUS")
    price_pro = env.get("STRIPE_PRICE_PRO")

    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set")
    if not stripe_key or not price_plus or not price_pro:
        pytest.skip("Stripe test keys or prices not configured")
    if stripe_key.startswith("sk_live_"):
        pytest.skip("Stripe proration test requires a test mode key (sk_test_*)")

    api_url = resolve_api_url(supabase_url)
    access_token = ensure_access_token(service_key, supabase_url)
    claims = decode_jwt_payload(access_token)
    user_id = claims.get("sub")
    assert user_id, "access token missing user id"
    email = claims.get("email") or f"stripe-proration-{uuid.uuid4().hex[:6]}@local.test"

    amount_plus = get_price_amount(stripe_key, price_plus)
    amount_pro = get_price_amount(stripe_key, price_pro)
    price_lookup = {
        "plus": (price_plus, amount_plus),
        "pro": (price_pro, amount_pro),
    }
    old_price_id, old_amount = price_lookup[old_plan_key]
    new_price_id, new_amount = price_lookup[new_plan_key]

    result = run_proration_case(
        env=eb_api_env,
        api_url=api_url,
        stripe_key=stripe_key,
        access_token=access_token,
        user_id=user_id,
        email=email,
        old_plan_key=old_plan_key,
        new_plan_key=new_plan_key,
        old_price_id=old_price_id,
        new_price_id=new_price_id,
        old_amount=old_amount,
        new_amount=new_amount,
        remaining_fraction=remaining_fraction,
    )

    expected_total = result["expected_total"]
    proration_total = result["proration_total"]
    diff = new_amount - old_amount
    assert proration_total != 0, "proration total should be non-zero"
    assert proration_total * diff > 0, "proration total should follow upgrade/downgrade direction"
    assert abs(proration_total - expected_total) <= 1, (proration_total, expected_total)

    label_map = {
        f"{old_plan_key.capitalize()} Plan": old_price_id,
        f"{new_plan_key.capitalize()} Plan": new_price_id,
    }
    totals_by_price = sum_proration_by_price(result["proration_lines"], label_map=label_map)
    assert old_price_id in totals_by_price, "missing proration for old plan"
    assert new_price_id in totals_by_price, "missing proration for new plan"

    expected_old = -int(round(old_amount * result["fraction"]))
    expected_new = int(round(new_amount * result["fraction"]))
    assert abs(totals_by_price[old_price_id] - expected_old) <= 1, (
        totals_by_price[old_price_id],
        expected_old,
    )
    assert abs(totals_by_price[new_price_id] - expected_new) <= 1, (
        totals_by_price[new_price_id],
        expected_new,
    )
