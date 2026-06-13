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
CONFIG_FILE = DIYM_HOME / "config.json"
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


# ── config.json (default-model etc.) ──────────────────────────────────

def load_config() -> dict[str, Any]:
    if CONFIG_FILE.is_file():
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return {"version": 1, "default_model": {}}


def save_config(cfg: dict[str, Any]) -> None:
    ensure_dirs()
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ── state file (was lock file) ────────────────────────────────────────

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
    """Build a state entry. Provider definition wins for API facts, state keeps user fields."""
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

    # Determine model IDs: prefer live /v1/models, then provider.yaml, then cache
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

    models: dict[str, dict[str, Any]] = {}
    for mid in ids:
        prev = existing_models.get(mid, {})
        meta = prov_models.get(mid, {})
        # API facts: provider definition wins (meta > prev)
        # max_tokens is client param: prev can override
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
            "error_last_code": prev.get("error_last_code"),
            "error_last_message": prev.get("error_last_message"),
            "error_last_time": prev.get("error_last_time"),
            "error_retry_times": prev.get("error_retry_times", 0),
            "error_retry_after": prev.get("error_retry_after"),
        }

    # Mark models that were in state but no longer in upstream as stale
    for mid, prev in existing_models.items():
        if mid not in models:
            models[mid] = {**prev, "stale": True}

    # Apply excludes from config
    cfg = load_config()
    provider_excludes = cfg.get("exclude_models", {}).get(name, [])
    for mid in provider_excludes:
        if mid in models:
            models[mid]["enabled"] = False

    state = {
        "version": LOCK_VERSION,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "provider": name,
        "provider_type": ptype,
        "models": models,
    }
    return state, label


def get_enabled_models(name: str) -> dict[str, dict[str, Any]]:
    """Return enabled non-stale models from state, with excludes applied."""
    state = load_state(name)
    if not state:
        return {}
    models = state.get("models", {})

    # Apply excludes from config as safety net
    cfg = load_config()
    provider_excludes = cfg.get("exclude_models", {}).get(name, [])
    for mid in provider_excludes:
        if mid in models:
            models[mid]["enabled"] = False

    return {mid: m for mid, m in models.items() if m.get("enabled") and not m.get("stale")}


def build_litellm_config(name: str, api_base: str, api_key: str, models: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Build a LiteLLM proxy config dict for a single provider."""
    model_list = []
    for mid, mdef in models.items():
        model_list.append({
            "model_name": f"{name}/{mid}",
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
