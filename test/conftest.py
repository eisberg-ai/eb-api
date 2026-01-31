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
        choices=["local", "prod"],
        help="Load env vars from .env.local or .env.prod before running tests.",
    )


def pytest_configure(config: pytest.Config) -> None:
  env_choice = config.getoption("--env")
  if not env_choice:
    return
  root = Path(__file__).resolve().parents[1]
  env_file = root / f".env.{env_choice}"
  env_vars = load_env_file(env_file)
  for key, value in env_vars.items():
    os.environ.setdefault(key, value)
