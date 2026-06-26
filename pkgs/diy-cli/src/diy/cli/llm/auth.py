"""diy-llm auth — credential management.

Credentials live in provider state files (~/.diy-llm/providers/*.json)
alongside model metadata. No separate auth.json. Hermes style.

Pure logic layer shared by CLI and GUI. No UI/print/sys.exit.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .core import PROVIDERS_DIR, ensure_dirs, load_state, save_state

DIYM_HOME = Path.home() / ".diy"


def load_dotenv(path: Path | None = None) -> None:
    """Load ~/.diy-llm/.env into os.environ, matching Hermes convention."""
    env_file = path or (DIYM_HOME / ".env")
    if not env_file.is_file():
        return
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value


# ── API key resolution ────────────────────────────────────────────


def resolve_api_key(source: str) -> str | None:
    """Resolve an API key from its source string (env:VAR_NAME)."""
    if source.startswith("env:"):
        return os.environ.get(source[4:])
    return None


# ── provider auth (stored in state file) ──────────────────────────


def get_provider_auth(name: str) -> dict[str, Any] | None:
    """Read {source, api_base, provider_type} from provider state file. Returns None if no auth."""
    state = load_state(name)
    if not state:
        return None
    source = state.get("source")
    if not source:
        return None
    return {
        "source": source,
        "api_base": state.get("api_base", ""),
        "provider_type": state.get("provider_type", name),
    }


def set_provider_auth(
    name: str, source: str, api_base: str, provider_type: str | None = None
) -> None:
    """Set source/api_base in provider state file. Creates file if needed."""
    ensure_dirs()
    existing = load_state(name) or {}

    # 有序构建：auth 字段在前，models 在后
    state: dict[str, Any] = {}
    state["source"] = source
    state["api_base"] = api_base
    state["provider_name"] = name
    state["provider_type"] = provider_type or name
    # 保留已有字段（version, updated_at, models 等），auth 字段优先
    for k, v in existing.items():
        if k not in state:
            state[k] = v

    save_state(name, state)


def remove_provider_auth(name: str) -> None:
    """Remove source/api_base from provider state file."""
    state = load_state(name)
    if state:
        state.pop("source", None)
        state.pop("api_base", None)
        save_state(name, state)


def list_providers_with_auth() -> dict[str, dict[str, Any]]:
    """Return {provider_name: {source, api_base}} for all providers with credentials."""
    result: dict[str, dict[str, Any]] = {}
    if PROVIDERS_DIR.is_dir():
        for f in sorted(PROVIDERS_DIR.glob("*.json")):
            name = f.stem
            a = get_provider_auth(name)
            if a:
                result[name] = a
    return result


def has_credential(name: str) -> bool:
    """Check if a provider has credentials registered in state."""
    return get_provider_auth(name) is not None
