"""diy-llm core — provider discovery, model sync, state management.

Pure logic layer shared by CLI and GUI. No UI/print/sys.exit.
"""

from __future__ import annotations

import importlib.resources
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import yaml

# ── paths ─────────────────────────────────────────────────────────────

DIYM_HOME = Path.home() / ".diy-llm"
PROVIDERS_DIR = DIYM_HOME / "providers"
LOCK_VERSION = 1


def ensure_dirs() -> None:
    PROVIDERS_DIR.mkdir(parents=True, exist_ok=True)


# ── provider type registry ────────────────────────────────────────────

def discover_provider_types() -> dict[str, Path]:
    """Find bundled provider types by scanning providers/ for provider.yaml."""
    try:
        prov_dir = importlib.resources.files("diy_llm").joinpath("providers")
    except Exception:
        return {}
    if not prov_dir.is_dir():
        return {}
    result: dict[str, Path] = {}
    for entry in sorted(prov_dir.iterdir()):
        if not entry.is_dir():
            continue
        prov_file = Path(str(entry)) / "provider.yaml"
        if prov_file.is_file():
            result[entry.name] = prov_file
    return result


def load_provider_type(ptype: str) -> dict[str, Any] | None:
    """Load a provider type's provider.yaml definition."""
    types = discover_provider_types()
    path = types.get(ptype)
    if not path:
        return None
    with open(path) as f:
        return yaml.safe_load(f)


# ── state file ────────────────────────────────────────────────────────

def state_path(provider_name: str) -> Path:
    return PROVIDERS_DIR / f"{provider_name}.json"


def load_state(provider_name: str) -> dict[str, Any] | None:
    path = state_path(provider_name)
    if not path.is_file():
        return None
    with open(path) as f:
        return json.load(f)


def save_state(provider_name: str, state: dict[str, Any]) -> None:
    ensure_dirs()
    with open(state_path(provider_name), "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ── model sync logic ─────────────────────────────────────────────────

def fetch_model_ids(api_base: str, api_key: str) -> list[str] | None:
    """Query /v1/models. Returns model ID list, None if 404 (no endpoint). Raises on other errors."""
    url = f"{api_base}/v1/models"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    raw = body.get("data") if isinstance(body, dict) else body
    if isinstance(raw, list):
        return [m.get("id", "") for m in raw if m.get("id")]
    return None


def ensure_state(name: str, api_base: str, api_key: str, ptype: str) -> tuple[dict[str, Any], str]:
    """Build a state entry. Whitelist = provider.yaml, MODEL_DEPRECATED for removed models."""
    existing = load_state(name)
    existing_models = existing.get("models", {}) if existing else {}

    # Load provider definition (models whitelist)
    prov_def = load_provider_type(ptype) or {}
    prov_models = prov_def.get("models", {})

    try:
        live_ids = fetch_model_ids(api_base, api_key)
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500:
            raise RuntimeError(f"4xx from provider: HTTP {e.code} — check your API key and endpoint") from e
        raise RuntimeError(f"5xx from provider: HTTP {e.code} — provider error") from e
    except Exception as e:
        raise RuntimeError(f"Network error: {e}") from e

    # Determine model IDs and whitelist behaviour
    if live_ids is not None:
        ids = live_ids
        label = "live /v1/models"
    elif prov_models:
        ids = list(prov_models.keys())
        label = "provider.yaml"
    elif existing_models:
        ids = list(existing_models.keys())
        label = "cached (no /v1/models)"
    else:
        raise RuntimeError(f"No model source for '{ptype}' — provider has no /v1/models and no provider.yaml models")

    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    upstream_set = set(ids) if live_ids is not None else None
    models: dict[str, dict[str, Any]] = {}

    # Only expose models declared in provider.yaml (whitelist) when fetching live
    whitelist_ids = list(prov_models.keys()) if prov_models else ids
    for mid in whitelist_ids:
        prev = existing_models.get(mid, {})
        meta = prov_models.get(mid, {})
        # API facts: provider definition wins
        models[mid] = {
            "id": mid,
            "label": meta.get("label", prev.get("name", prev.get("label", mid))),
            "enabled": prev.get("enabled", True),
            "context_window": meta.get("context_window", prev.get("context_window", 128000)),
            "max_tokens": prev.get("max_tokens", meta.get("max_tokens", 4096)),
            "reasoning": meta.get("reasoning", prev.get("reasoning", False)),
            "cost": meta.get("cost", prev.get("cost", {"input": 0, "output": 0})),
            "compat": meta.get("compat", prev.get("compat", {})),
            "status": prev.get("status", "ok"),
            "error": prev.get("error"),
        }

        # MODEL_DEPRECATED: declared in provider.yaml but not returned by upstream
        if upstream_set is not None and mid not in upstream_set:
            models[mid]["status"] = "error"
            models[mid]["error"] = {
                "code": "MODEL_DEPRECATED",
                "message": "上游已下架，不再建议使用",
                "time": now,
            }

    # Retain models that have existing user history but aren't in whitelist (stale)
    for mid, prev in existing_models.items():
        if mid not in models:
            models[mid] = {**prev, "stale": True}

    state = {
        "version": LOCK_VERSION,
        "updated_at": now,
        "provider": name,
        "provider_type": ptype,
        "models": models,
    }
    return state, label


def get_enabled_models(name: str) -> dict[str, dict[str, Any]]:
    """Return enabled, non-stale, non-error models from state."""
    state = load_state(name)
    if not state:
        return {}
    models = state.get("models", {})
    return {
        mid: m for mid, m in models.items()
        if m.get("enabled") and not m.get("stale") and m.get("status") not in ("error", "exhausted")
    }


def list_models(name: str) -> dict[str, dict[str, Any]]:
    """Return all models from state with their status, for display."""
    state = load_state(name)
    if not state:
        return {}
    return state.get("models", {})


def clean_models(name: str) -> list[str]:
    """Remove MODEL_DEPRECATED models from state. Returns list of removed IDs."""
    state = load_state(name)
    if not state:
        return []
    models = state.get("models", {})
    removed = [
        mid for mid, m in models.items()
        if isinstance(m.get("error"), dict) and m["error"].get("code") == "MODEL_DEPRECATED"
    ]
    for mid in removed:
        del models[mid]
    save_state(name, state)
    return removed


def build_litellm_config(models_by_provider: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Build a LiteLLM proxy config dict for one or more providers.

    models_by_provider: {provider_name: {model_id: {api_base, api_key, models: {mid: meta}}}}
    """
    model_list = []
    for pname, pdef in models_by_provider.items():
        api_base = pdef["api_base"]
        api_key = pdef["api_key"]
        for mid in pdef["models"]:
            model_list.append({
                "model_name": f"{pname}/{mid}",
                "litellm_params": {
                    "model": f"custom_openai/{mid}",
                    "api_base": api_base,
                    "api_key": api_key,
                },
            })

    return {
        "model_list": model_list,
        "litellm_settings": {"drop_params": True, "set_verbose": False},
        "general_settings": {},
    }
