"""diy-llm export — sync diy-llm configuration to downstream tools.

Builds provider configs for PI agent, Hermes, etc. from diy-llm state.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from diy_llm import auth
from diy_llm.core import (
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

        ptype_def = load_provider_type(pname) or {}
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

            entry: dict[str, Any] = {
                "id": mid,
                "name": meta.get("label", mid),
                "reasoning": bool(meta.get("reasoning", False)),
                "input": ["text"],
                "contextWindow": meta.get("context_window", 128000),
                "maxTokens": editable.get("max_tokens", 4096),
                "cost": meta.get("cost", {}),
            }

            compat = meta.get("compat")
            if compat:
                entry["compat"] = compat

            models_list.append(entry)

        if not models_list:
            continue

        api_base = pauth.get("api_base", "").rstrip("/")

        # Build PI provider entry
        pi_providers[f"diy-{pname}"] = {
            "baseUrl": api_base,
            "api": "openai-completions",
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
