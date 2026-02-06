"""
Local integration tests for billing spend flows (LLM usage + build spend).
"""
from __future__ import annotations

import math

import pytest
import requests

from test.utils import auth_headers, ensure_access_token, resolve_api_url, resolve_env


def get_balance(api_url: str, token: str) -> float:
    resp = requests.get(f"{api_url}/billing/credits", headers=auth_headers(token), timeout=15)
    assert resp.status_code == 200, resp.text
    return float(resp.json().get("balance") or 0)


def get_pricing(api_url: str, token: str) -> dict:
    resp = requests.get(f"{api_url}/billing/pricing", headers=auth_headers(token), timeout=15)
    assert resp.status_code == 200, resp.text
    return resp.json().get("llmPricing") or {}


def compute_quote(pricing: dict, model: str, input_tokens: int, output_tokens: int) -> tuple[float, float, float]:
    key = model.lower()
    entry = pricing.get(key)
    assert entry, f"pricing missing for {model}"
    input_usd = float(entry.get("inputUsdPer1M") or 0)
    output_usd = float(entry.get("outputUsdPer1M") or 0)
    base = (input_tokens / 1_000_000) * input_usd + (output_tokens / 1_000_000) * output_usd
    markup = base * 0.15
    total = base + markup
    return base, markup, total


@pytest.mark.local
@pytest.mark.integration
def test_billing_llm_usage_charges_and_records() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required.")

    api_url = resolve_api_url(supabase_url, env)
    token = ensure_access_token(service_key, supabase_url)

    start_balance = get_balance(api_url, token)
    pricing = get_pricing(api_url, token)

    model = "anthropic/claude-3-5-sonnet-20241022"
    input_tokens = 1200
    output_tokens = 300
    base, markup, total = compute_quote(pricing, model, input_tokens, output_tokens)
    assert total > 0

    resp = requests.post(
        f"{api_url}/billing/llm-usage",
        headers=auth_headers(token),
        json={
            "model": model,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
        },
        timeout=20,
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert abs(float(payload.get("charged") or 0) - total) <= 1e-6
    assert abs(float(payload.get("base") or 0) - base) <= 1e-6
    assert abs(float(payload.get("markup") or 0) - markup) <= 1e-6

    end_balance = get_balance(api_url, token)
    assert abs((start_balance - end_balance) - total) <= 1e-6


@pytest.mark.local
@pytest.mark.integration
def test_billing_llm_usage_insufficient_drains_balance() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required.")

    api_url = resolve_api_url(supabase_url, env)
    token = ensure_access_token(service_key, supabase_url)

    balance = get_balance(api_url, token)
    if balance <= 0.05:
        pytest.skip("balance too low to run insufficient balance test")

    target_remaining = 0.01
    spend_amount = max(0.0, balance - target_remaining)
    if spend_amount > 0:
        spend_resp = requests.post(
            f"{api_url}/billing/credits/spend",
            headers=auth_headers(token),
            json={"credits": spend_amount, "description": "drain for llm usage test"},
            timeout=20,
        )
        assert spend_resp.status_code == 200, spend_resp.text

    pricing = get_pricing(api_url, token)
    model = "anthropic/claude-3-5-sonnet-20241022"
    input_usd = float(pricing[model.lower()]["inputUsdPer1M"])
    total_per_token = (input_usd / 1_000_000) * 1.15
    required = target_remaining + 0.5
    input_tokens = int(math.ceil(required / total_per_token))

    resp = requests.post(
        f"{api_url}/billing/llm-usage",
        headers=auth_headers(token),
        json={
            "model": model,
            "inputTokens": input_tokens,
            "outputTokens": 0,
        },
        timeout=20,
    )
    assert resp.status_code == 402, resp.text
    payload = resp.json()
    assert payload.get("error") == "insufficient_balance"
    assert float(payload.get("drained") or 0) > 0

    final_balance = get_balance(api_url, token)
    assert final_balance <= 0.0001


@pytest.mark.local
@pytest.mark.integration
def test_billing_build_spend_success_and_insufficient() -> None:
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        pytest.skip("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required.")

    api_url = resolve_api_url(supabase_url, env)
    token = ensure_access_token(service_key, supabase_url)

    start_balance = get_balance(api_url, token)
    if start_balance <= 0.2:
        pytest.skip("balance too low for build spend test")

    amount = min(0.5, start_balance / 2)
    build_id = f"build-test-{int(start_balance * 100000)}"
    spend_resp = requests.post(
        f"{api_url}/billing/build-spend",
        headers=auth_headers(token),
        json={"amount": amount, "buildId": build_id},
        timeout=20,
    )
    assert spend_resp.status_code == 200, spend_resp.text
    after_balance = get_balance(api_url, token)
    assert abs((start_balance - after_balance) - amount) <= 1e-6

    overspend_resp = requests.post(
        f"{api_url}/billing/build-spend",
        headers=auth_headers(token),
        json={"amount": after_balance + 1, "buildId": build_id},
        timeout=20,
    )
    assert overspend_resp.status_code == 402, overspend_resp.text

    final_balance = get_balance(api_url, token)
    assert final_balance <= 0.0001
