"""diy-llm export — sync diy-llm configuration to downstream tools.

Builds provider configs for PI agent, Hermes, etc. from diy-llm state.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import yaml

from . import auth
from .core import (
    _is_enabled,
    load_provider_type,
    load_state,
)

# Default PI agent config locations (in priority order)
PI_AGENT_PATHS = [
    Path.home() / ".pi" / "agent" / "models.json",
    Path.home() / ".config" / "pi" / "agent" / "models.json",
]


def _find_pi_config() -> Path | None:
    for p in PI_AGENT_PATHS:
        if p.is_file():
            return p
    return None


def _ensure_pi_config() -> Path:
    path = _find_pi_config() or PI_AGENT_PATHS[0]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.is_file():
        path.write_text('{"providers": {}}\n')
    return path


# ── PI agent provider builder ──────────────────────────────────


def build_pi_providers(
    provider_names: list[str] | None = None,
) -> dict[str, Any]:
    """Build PI agent provider entries from diy-llm state.

    Args:
        provider_names: If provided, only sync these providers.
                       If None, sync all providers with credentials.

    Returns:
        Dict suitable for models.json's ``providers`` key.
        Keys are prefixed with ``diy-``.
    """
    if provider_names:
        providers_to_sync: dict[str, Any] = {}
        for n in provider_names:
            a = auth.get_provider_auth(n)
            if a:
                providers_to_sync[n] = a
    else:
        providers_to_sync = auth.list_providers_with_auth()

    pi_providers: dict[str, Any] = {}

    for pname, pauth in providers_to_sync.items():
        state = load_state(pname)
        if not state:
            continue

        api_key = auth.resolve_api_key(pauth["source"])
        if not api_key:
            continue

        # 从 auth 中读取 provider_type（支持 name 实例）
        provider_type = pauth.get("provider_type", pname)
        ptype_def = load_provider_type(provider_type) or {}
        ptype_models = ptype_def.get("models", {})
        state_models = state.get("models", {})

        if not state_models or not ptype_models:
            continue

        # Build model list
        models_list: list[dict[str, Any]] = []
        for mid, m_state in state_models.items():
            if not _is_enabled(m_state):
                continue
            if m_state.get("stale"):
                continue
            if m_state.get("status") in ("error", "exhausted"):
                continue

            meta = ptype_models.get(mid, {})
            editable = m_state.get("editable", {})

            cost = meta.get("cost")
            if not cost:
                cost = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}

            entry: dict[str, Any] = {
                "id": mid,
                "name": meta.get("label", mid),
                "reasoning": bool(meta.get("reasoning", False)),
                "input": ["text"],
                "contextWindow": meta.get("context_window", 128000),
                "maxTokens": editable.get("max_tokens", 4096),
                "cost": cost,
            }

            compat = meta.get("compat")
            if compat:
                entry["compat"] = compat

            models_list.append(entry)

        if not models_list:
            continue

        api_base = pauth.get("api_base", "").rstrip("/")

        # Map protocol to PI agent API type
        protocol = (ptype_def.get("api") or {}).get("protocol", "openai-compatible")
        pi_api_type = {
            "google-native": "google-generative-ai",
        }.get(protocol, "openai-completions")

        # Build PI provider entry
        pi_providers[f"diy-{pname}"] = {
            "baseUrl": api_base,
            "api": pi_api_type,
            "apiKey": api_key,
            "models": models_list,
        }

    return pi_providers


# ── PI agent config file I/O ───────────────────────────────────


def read_pi_config(path: str | Path | None = None) -> dict[str, Any]:
    """Read and return the full PI agent models.json."""
    cfg_path = Path(path) if path else _ensure_pi_config()
    if not cfg_path.is_file():
        return {"providers": {}}
    with open(cfg_path) as f:
        return json.load(f)


def write_pi_config(
    config: dict[str, Any],
    path: str | Path | None = None,
) -> Path:
    """Write the full PI agent models.json. Returns the path written."""
    cfg_path = Path(path) if path else _ensure_pi_config()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg_path, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return cfg_path


def merge_diy_providers(
    providers: dict[str, Any],
) -> dict[str, Any]:
    """Merge diy-llm providers into an existing PI providers dict.

    Strategy: remove all existing ``diy-*`` keys, then write fresh.
    """
    existing = dict(providers)
    # Remove all diy-* providers (ours to manage)
    for key in list(existing.keys()):
        if key.startswith("diy-"):
            del existing[key]
    # Add new ones
    new_diy = build_pi_providers()
    existing.update(new_diy)
    return existing


# ── Hermes config builder ────────────────────────────────────────

HERMES_CONFIG = Path.home() / ".hermes" / "config.yaml"


def build_hermes_providers(
    provider_names: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Build Hermes custom_providers entries from diy-llm state.

    Args:
        provider_names: If provided, only sync these providers.
                       If None, sync all providers with credentials.

    Returns:
        List of dicts suitable for Hermes config.yaml's ``custom_providers`` key.
        Each entry is keyed by ``diy-<provider_name>``.
    """
    if provider_names:
        providers_to_sync: dict[str, Any] = {}
        for n in provider_names:
            a = auth.get_provider_auth(n)
            if a:
                providers_to_sync[n] = a
    else:
        providers_to_sync = auth.list_providers_with_auth()

    hermes_providers: list[dict[str, Any]] = []

    for pname, pauth in providers_to_sync.items():
        state = load_state(pname)
        if not state:
            continue

        api_key = auth.resolve_api_key(pauth["source"])
        if not api_key:
            continue

        # 从 auth 中读取 provider_type（支持 name 实例）
        provider_type = pauth.get("provider_type", pname)
        ptype_def = load_provider_type(provider_type) or {}
        ptype_models = ptype_def.get("models", {})
        state_models = state.get("models", {})

        if not state_models or not ptype_models:
            continue

        # Build model list
        models: dict[str, dict[str, Any]] = {}
        for mid, m_state in state_models.items():
            if not _is_enabled(m_state):
                continue
            if m_state.get("stale"):
                continue
            if m_state.get("status") in ("error", "exhausted"):
                continue

            meta = ptype_models.get(mid, {})
            ctx = meta.get("context_window", 128000)

            models[mid] = {
                "context_length": ctx,
            }

        if not models:
            continue

        api_base = pauth.get("api_base", "").rstrip("/")

        # Determine default model: first enabled model
        default_model = next(iter(models.keys()))

        entry: dict[str, Any] = {
            "name": f"diy-{pname}",
            "discover_models": False,
            "base_url": api_base,
            "api_key": api_key,
            "models": models,
            "model": default_model,
        }

        # Only set api_mode if protocol is explicitly non-OpenAI
        protocol = (ptype_def.get("api") or {}).get("protocol", "")
        if protocol == "anthropic":
            entry["api_mode"] = "anthropic_messages"

        hermes_providers.append(entry)

    return hermes_providers


# ── Hermes config file I/O ───────────────────────────────────────


def read_hermes_config(path: str | Path | None = None) -> dict[str, Any]:
    """Read the full Hermes config.yaml. Returns empty dict if missing."""
    cfg_path = Path(path) if path else HERMES_CONFIG
    if not cfg_path.is_file():
        return {}
    with open(cfg_path) as f:
        return yaml.safe_load(f) or {}


class _HermesYAMLDumper(yaml.Dumper):
    """Preserve config.yaml structure when writing back."""

    pass


def _hermes_yaml_dump(data: dict[str, Any]) -> str:
    """Dump dict to YAML string matching Hermes config.yaml style."""
    buf = io.StringIO()
    yaml.dump(
        data,
        buf,
        Dumper=_HermesYAMLDumper,
        default_flow_style=False,
        allow_unicode=True,
        sort_keys=False,
        width=120,
    )
    return buf.getvalue()


def write_hermes_config(
    config: dict[str, Any],
    path: str | Path | None = None,
) -> Path:
    """Write the full Hermes config.yaml. Returns the path written."""
    cfg_path = Path(path) if path else HERMES_CONFIG
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg_path, "w") as f:
        f.write(_hermes_yaml_dump(config))
    return cfg_path


def merge_hermes_custom_providers(
    hermes_providers: list[dict[str, Any]],
) -> dict[str, Any]:
    """Merge diy-llm providers into existing Hermes config.

    Strategy: read existing config.yaml, remove all existing ``diy-*``
    entries from ``custom_providers``, then append the new ones.
    Preserves all other config sections untouched.

    Returns the full merged config dict (not yet written to disk).
    """
    config = read_hermes_config()

    existing = list(config.get("custom_providers", []))
    # Remove all diy-* providers (ours to manage)
    kept = [p for p in existing if not p.get("name", "").startswith("diy-")]
    # Append new ones
    config["custom_providers"] = kept + hermes_providers

    return config
