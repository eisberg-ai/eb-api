"""
Integration tests for the icon generation endpoint.

Covers:
- POST /generate-icon (generate app icon PNG)
- GET /generate-icon?icon=...&size=... (same via query params)
- Authentication requirements
- Input validation
- PNG output verification

Run with:
    pytest test/local/test_generate_icon.py -v

To save output PNGs for inspection:
    pytest test/local/test_generate_icon.py -v --save-icons
"""
from __future__ import annotations

from pathlib import Path

import pytest
import requests

from test.utils import (
    auth_headers,
    ensure_access_token,
    resolve_api_url,
    resolve_env,
)

# Valid icon and color combinations
VALID_ICONS = ["rocket", "star", "zap", "heart", "globe", "music", "camera", "game", "sparkles"]
VALID_COLORS = ["cyan", "teal", "indigo", "violet", "pink"]


def _build_api_url(env: dict[str, str]) -> str:
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is required for integration tests.")
    return resolve_api_url(supabase_url, env)


def _is_valid_png(data: bytes) -> bool:
    """Check if data starts with PNG magic bytes."""
    return data[:8] == b'\x89PNG\r\n\x1a\n'


def pytest_addoption(parser: pytest.Parser) -> None:
    """Add --save-icons option to save generated PNGs for inspection."""
    try:
        parser.addoption(
            "--save-icons",
            action="store_true",
            default=False,
            help="Save generated icon PNGs to test/local/output/ for inspection",
        )
    except ValueError:
        # Option already added
        pass


@pytest.fixture
def save_icons(request) -> bool:
    """Whether to save generated icons to disk."""
    return request.config.getoption("--save-icons", default=False)


@pytest.fixture
def output_dir() -> Path:
    """Directory for saving test output."""
    path = Path(__file__).parent / "output"
    path.mkdir(exist_ok=True)
    return path


@pytest.mark.local
@pytest.mark.integration
def test_generate_icon_post_success(save_icons: bool, output_dir: Path) -> None:
    """Should generate a valid PNG for a POST request with icon parameter."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/generate-icon",
        headers=headers,
        json={"icon": "rocket:cyan", "size": 256},
        timeout=60,
    )
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    assert resp.headers.get("Content-Type") == "image/png"
    assert _is_valid_png(resp.content), "Response is not a valid PNG"
    assert len(resp.content) > 1000, "PNG seems too small"

    if save_icons:
        (output_dir / "icon_rocket_cyan_256.png").write_bytes(resp.content)


@pytest.mark.local
@pytest.mark.integration
def test_generate_icon_get_success(save_icons: bool, output_dir: Path) -> None:
    """Should generate a valid PNG for a GET request with query params."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.get(
        f"{api_url}/generate-icon",
        headers=headers,
        params={"icon": "star:violet", "size": "512"},
        timeout=60,
    )
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    assert resp.headers.get("Content-Type") == "image/png"
    assert _is_valid_png(resp.content), "Response is not a valid PNG"

    if save_icons:
        (output_dir / "icon_star_violet_512.png").write_bytes(resp.content)


@pytest.mark.local
@pytest.mark.integration
@pytest.mark.parametrize("icon_id", VALID_ICONS)
def test_generate_icon_all_icons(icon_id: str, save_icons: bool, output_dir: Path) -> None:
    """Should generate valid PNGs for all icon types."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/generate-icon",
        headers=headers,
        json={"icon": f"{icon_id}:cyan", "size": 256},
        timeout=60,
    )
    assert resp.status_code == 200, f"Failed for icon {icon_id}: {resp.text}"
    assert _is_valid_png(resp.content), f"Invalid PNG for icon {icon_id}"

    if save_icons:
        (output_dir / f"icon_{icon_id}_cyan_256.png").write_bytes(resp.content)


@pytest.mark.local
@pytest.mark.integration
@pytest.mark.parametrize("color_id", VALID_COLORS)
def test_generate_icon_all_colors(color_id: str, save_icons: bool, output_dir: Path) -> None:
    """Should generate valid PNGs for all color options."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/generate-icon",
        headers=headers,
        json={"icon": f"rocket:{color_id}", "size": 256},
        timeout=60,
    )
    assert resp.status_code == 200, f"Failed for color {color_id}: {resp.text}"
    assert _is_valid_png(resp.content), f"Invalid PNG for color {color_id}"

    if save_icons:
        (output_dir / f"icon_rocket_{color_id}_256.png").write_bytes(resp.content)


@pytest.mark.local
@pytest.mark.integration
@pytest.mark.parametrize("size", [64, 128, 256, 512])
def test_generate_icon_sizes(size: int, save_icons: bool, output_dir: Path) -> None:
    """Should generate PNGs at different sizes."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/generate-icon",
        headers=headers,
        json={"icon": "sparkles:indigo", "size": size},
        timeout=60,
    )
    assert resp.status_code == 200, f"Failed for size {size}: {resp.text}"
    assert _is_valid_png(resp.content), f"Invalid PNG for size {size}"

    if save_icons:
        (output_dir / f"icon_sparkles_indigo_{size}.png").write_bytes(resp.content)


@pytest.mark.local
@pytest.mark.integration
def test_generate_icon_default_color() -> None:
    """Should use default color (cyan) when not specified."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    # Just "rocket" without color
    resp = requests.post(
        f"{api_url}/generate-icon",
        headers=headers,
        json={"icon": "rocket"},
        timeout=60,
    )
    assert resp.status_code == 200, resp.text
    assert _is_valid_png(resp.content)


@pytest.mark.local
@pytest.mark.integration
def test_generate_icon_requires_icon_param() -> None:
    """Should return 400 if icon parameter is missing."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/generate-icon",
        headers=headers,
        json={},
        timeout=30,
    )
    assert resp.status_code == 400, resp.text
    assert "icon" in resp.json().get("error", "").lower()


@pytest.mark.local
@pytest.mark.integration
def test_generate_icon_invalid_icon() -> None:
    """Should return 400 for unknown icon ID."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/generate-icon",
        headers=headers,
        json={"icon": "invalidicon:cyan"},
        timeout=30,
    )
    assert resp.status_code == 400, resp.text
    assert "unknown icon" in resp.json().get("error", "").lower()


@pytest.mark.local
@pytest.mark.integration
def test_generate_icon_invalid_color() -> None:
    """Should return 400 for unknown color ID."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/generate-icon",
        headers=headers,
        json={"icon": "rocket:invalidcolor"},
        timeout=30,
    )
    assert resp.status_code == 400, resp.text
    assert "unknown color" in resp.json().get("error", "").lower()


@pytest.mark.local
@pytest.mark.integration
def test_generate_icon_requires_auth() -> None:
    """Should reject unauthenticated requests."""
    env = resolve_env()
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        pytest.skip("SUPABASE_URL not set.")

    api_url = resolve_api_url(supabase_url, env)

    resp = requests.post(
        f"{api_url}/generate-icon",
        json={"icon": "rocket:cyan"},
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    assert resp.status_code == 401


@pytest.mark.local
@pytest.mark.integration
def test_generate_icon_caching_headers() -> None:
    """Should return appropriate caching headers."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")

    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    headers = auth_headers(access_token)

    resp = requests.post(
        f"{api_url}/generate-icon",
        headers=headers,
        json={"icon": "heart:pink"},
        timeout=60,
    )
    assert resp.status_code == 200
    # Should have aggressive caching since icons are deterministic
    cache_control = resp.headers.get("Cache-Control", "")
    assert "max-age" in cache_control or "public" in cache_control
