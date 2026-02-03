from __future__ import annotations

import os
from pathlib import Path

import pytest

from test.utils import load_env_file


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--env",
        action="store",
        default=None,
        help="Load env vars from .env.local/.env.prod or a specific env file path.",
    )


def pytest_configure(config: pytest.Config) -> None:
    # Register markers
    config.addinivalue_line("markers", "unit: pure functions, no deps")
    config.addinivalue_line("markers", "local: needs task dev:local")
    config.addinivalue_line("markers", "multi: needs multiple repos")
    config.addinivalue_line("markers", "cloud: needs cloud infra")
    config.addinivalue_line("markers", "e2e: full platform + LLM")

    # Load env file if specified
    env_choice = config.getoption("--env")
    if not env_choice:
        return
    root = Path(__file__).resolve().parents[1]
    env_file = Path(env_choice)
    if env_choice in {"local", "prod"}:
        env_file = root / f".env.{env_choice}"
    if not env_file.is_absolute():
        env_file = (root / env_file).resolve()
    os.environ["EB_API_ENV_FILE"] = str(env_file)
    env_vars = load_env_file(env_file)
    for key, value in env_vars.items():
        os.environ[key] = value


@pytest.fixture
def fixtures_path(request):
    """Path to fixtures folder nearest to the test file."""
    test_dir = Path(request.fspath).parent
    if (test_dir / "fixtures").exists():
        return test_dir / "fixtures"
    return Path(__file__).parent / "fixtures"
