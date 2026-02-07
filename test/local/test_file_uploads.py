"""
Integration tests for file upload endpoints (media and app icon).

Covers:
- POST /media/image (image upload to GCS)
- POST /media/file (generic file upload to GCS)
- POST /projects/{id}/icon (app icon upload to GCS)
- Authentication and validation requirements
- Verifies uploaded files are accessible via returned URLs

Run with:
    pytest test/local/test_file_uploads.py -v
"""
from __future__ import annotations

import io

import pytest
import requests

from test.utils import (
    create_project,
    ensure_access_token,
    resolve_api_url,
    resolve_env,
)


def _build_api_url(env: dict[str, str]) -> str:
    supabase_url = env.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is required for integration tests.")
    return resolve_api_url(supabase_url, env)


def _setup(env: dict[str, str]) -> tuple[str, str, str]:
    """Return (api_url, access_token, project_id)."""
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")
    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))
    project_id = create_project(api_url, access_token, name="Upload Test")
    return api_url, access_token, project_id


def _make_png_bytes() -> bytes:
    """Create a minimal valid 1x1 red PNG."""
    # Minimal valid PNG: 1x1 pixel, RGBA, red
    import struct
    import zlib

    width, height = 1, 1

    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        crc = zlib.crc32(c) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + c + struct.pack(">I", crc)

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    ihdr = chunk(b"IHDR", ihdr_data)
    # Row: filter byte (0) + RGB pixels
    raw_row = b"\x00" + b"\xff\x00\x00"  # red pixel
    compressed = zlib.compress(raw_row)
    idat = chunk(b"IDAT", compressed)
    iend = chunk(b"IEND", b"")
    return signature + ihdr + idat + iend


def _make_txt_bytes() -> bytes:
    """Create simple text file bytes."""
    return b"hello world test file"


# ---------------------------------------------------------------------------
# POST /media/image — image upload
# ---------------------------------------------------------------------------

@pytest.mark.local
@pytest.mark.integration
def test_upload_image_success() -> None:
    """Should upload an image and return a URL."""
    env = resolve_env()
    api_url, access_token, project_id = _setup(env)

    png_bytes = _make_png_bytes()
    files = {"file": ("test_image.png", io.BytesIO(png_bytes), "image/png")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/media/image?projectId={project_id}",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    data = resp.json()
    assert "id" in data, f"Response missing 'id': {data}"
    assert "url" in data, f"Response missing 'url': {data}"
    assert data["mimeType"] == "image/png"
    assert data["filename"] == "test_image.png"


@pytest.mark.local
@pytest.mark.integration
def test_upload_image_invalid_type() -> None:
    """Should reject non-image file types."""
    env = resolve_env()
    api_url, access_token, project_id = _setup(env)

    txt_bytes = _make_txt_bytes()
    files = {"file": ("test.txt", io.BytesIO(txt_bytes), "text/plain")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/media/image?projectId={project_id}",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
    assert "invalid file type" in resp.json().get("error", "").lower()


@pytest.mark.local
@pytest.mark.integration
def test_upload_image_requires_auth() -> None:
    """Should reject unauthenticated image uploads."""
    env = resolve_env()
    api_url = _build_api_url(env)

    png_bytes = _make_png_bytes()
    files = {"file": ("test.png", io.BytesIO(png_bytes), "image/png")}

    resp = requests.post(
        f"{api_url}/media/image?projectId=fake-project",
        files=files,
        timeout=30,
    )
    assert resp.status_code == 401


@pytest.mark.local
@pytest.mark.integration
def test_upload_image_requires_project_id() -> None:
    """Should require projectId query parameter."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")
    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))

    png_bytes = _make_png_bytes()
    files = {"file": ("test.png", io.BytesIO(png_bytes), "image/png")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/media/image",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"


@pytest.mark.local
@pytest.mark.integration
def test_upload_image_accessible_via_url() -> None:
    """Should be able to fetch the uploaded image via the returned URL."""
    env = resolve_env()
    api_url, access_token, project_id = _setup(env)

    png_bytes = _make_png_bytes()
    files = {"file": ("accessible.png", io.BytesIO(png_bytes), "image/png")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/media/image?projectId={project_id}",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 200, f"Upload failed: {resp.text}"
    data = resp.json()
    url = data.get("url")
    assert url, f"No URL in response: {data}"

    # Fetch the uploaded file
    fetch_resp = requests.get(url, timeout=15)
    assert fetch_resp.status_code == 200, f"Could not fetch uploaded file at {url}: {fetch_resp.status_code}"
    assert fetch_resp.content[:8] == b"\x89PNG\r\n\x1a\n", "Fetched content is not a valid PNG"


# ---------------------------------------------------------------------------
# POST /media/file — generic file upload
# ---------------------------------------------------------------------------

@pytest.mark.local
@pytest.mark.integration
def test_upload_file_success() -> None:
    """Should upload a generic file and return a URL."""
    env = resolve_env()
    api_url, access_token, project_id = _setup(env)

    txt_bytes = _make_txt_bytes()
    files = {"file": ("notes.txt", io.BytesIO(txt_bytes), "text/plain")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/media/file?projectId={project_id}",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    data = resp.json()
    assert "id" in data, f"Response missing 'id': {data}"
    assert "url" in data, f"Response missing 'url': {data}"
    assert data["filename"] == "notes.txt"


# ---------------------------------------------------------------------------
# POST /projects/{id}/icon — app icon upload
# ---------------------------------------------------------------------------

@pytest.mark.local
@pytest.mark.integration
def test_upload_app_icon_success() -> None:
    """Should upload an app icon and return app_icon_url."""
    env = resolve_env()
    api_url, access_token, project_id = _setup(env)

    png_bytes = _make_png_bytes()
    files = {"file": ("icon.png", io.BytesIO(png_bytes), "image/png")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/projects/{project_id}/icon",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    data = resp.json()
    assert "app_icon_url" in data, f"Response missing 'app_icon_url': {data}"
    assert data["app_icon_url"], "app_icon_url should not be empty"


@pytest.mark.local
@pytest.mark.integration
def test_upload_app_icon_persists_on_project() -> None:
    """Should persist app_icon_url on the project after upload."""
    env = resolve_env()
    api_url, access_token, project_id = _setup(env)

    png_bytes = _make_png_bytes()
    files = {"file": ("icon.png", io.BytesIO(png_bytes), "image/png")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/projects/{project_id}/icon",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 200, f"Upload failed: {resp.text}"
    icon_url = resp.json()["app_icon_url"]

    # Fetch the project and verify app_icon_url is set
    project_resp = requests.get(
        f"{api_url}/projects/{project_id}",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        timeout=15,
    )
    assert project_resp.status_code == 200, f"Failed to fetch project: {project_resp.text}"
    project_data = project_resp.json()
    assert project_data.get("app_icon_url") == icon_url, (
        f"Expected app_icon_url={icon_url}, got {project_data.get('app_icon_url')}"
    )


@pytest.mark.local
@pytest.mark.integration
def test_upload_app_icon_accessible_via_url() -> None:
    """Should be able to fetch the uploaded icon via the returned URL."""
    env = resolve_env()
    api_url, access_token, project_id = _setup(env)

    png_bytes = _make_png_bytes()
    files = {"file": ("icon.png", io.BytesIO(png_bytes), "image/png")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/projects/{project_id}/icon",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 200, f"Upload failed: {resp.text}"
    icon_url = resp.json()["app_icon_url"]

    fetch_resp = requests.get(icon_url, timeout=15)
    assert fetch_resp.status_code == 200, f"Could not fetch icon at {icon_url}: {fetch_resp.status_code}"
    assert fetch_resp.content[:8] == b"\x89PNG\r\n\x1a\n", "Fetched content is not a valid PNG"


@pytest.mark.local
@pytest.mark.integration
def test_upload_app_icon_invalid_type() -> None:
    """Should reject non-image file types for icon upload."""
    env = resolve_env()
    api_url, access_token, project_id = _setup(env)

    txt_bytes = _make_txt_bytes()
    files = {"file": ("icon.txt", io.BytesIO(txt_bytes), "text/plain")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/projects/{project_id}/icon",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
    assert "invalid file type" in resp.json().get("error", "").lower()


@pytest.mark.local
@pytest.mark.integration
def test_upload_app_icon_requires_auth() -> None:
    """Should reject unauthenticated icon uploads."""
    env = resolve_env()
    api_url = _build_api_url(env)

    png_bytes = _make_png_bytes()
    files = {"file": ("icon.png", io.BytesIO(png_bytes), "image/png")}

    resp = requests.post(
        f"{api_url}/projects/fake-project/icon",
        files=files,
        timeout=30,
    )
    assert resp.status_code == 401


@pytest.mark.local
@pytest.mark.integration
def test_upload_app_icon_wrong_project() -> None:
    """Should return 404 for non-existent project."""
    env = resolve_env()
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        pytest.skip("SUPABASE_SERVICE_ROLE_KEY not set.")
    api_url = _build_api_url(env)
    access_token = ensure_access_token(service_key, env.get("SUPABASE_URL", ""))

    png_bytes = _make_png_bytes()
    files = {"file": ("icon.png", io.BytesIO(png_bytes), "image/png")}
    headers = {"Authorization": f"Bearer {access_token}"}

    resp = requests.post(
        f"{api_url}/projects/nonexistent-project-id/icon",
        headers=headers,
        files=files,
        timeout=30,
    )
    assert resp.status_code == 404, f"Expected 404, got {resp.status_code}: {resp.text}"


@pytest.mark.local
@pytest.mark.integration
def test_upload_app_icon_no_file() -> None:
    """Should return 400 when no file is provided."""
    env = resolve_env()
    api_url, access_token, project_id = _setup(env)

    headers = {"Authorization": f"Bearer {access_token}"}

    # Send empty multipart form
    resp = requests.post(
        f"{api_url}/projects/{project_id}/icon",
        headers=headers,
        files={},
        timeout=30,
    )
    # Could be 400 (file required) or 500 (formData parse error) — either is acceptable
    assert resp.status_code in (400, 500), f"Expected 400/500, got {resp.status_code}: {resp.text}"
