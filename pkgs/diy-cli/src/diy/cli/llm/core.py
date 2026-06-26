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

DIYM_HOME = Path.home() / ".diy"
PROVIDERS_DIR = DIYM_HOME / "models"
LOCK_VERSION = 1


def ensure_dirs() -> None:
    PROVIDERS_DIR.mkdir(parents=True, exist_ok=True)


# ── provider type registry ────────────────────────────────────────────


def discover_provider_types() -> dict[str, Path]:
    """Find bundled provider types by scanning providers/ for provider.yaml."""
    try:
        prov_dir = importlib.resources.files("diy.cli.llm").joinpath("providers")
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
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
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


def ensure_state(
    name: str, api_base: str, api_key: str, ptype: str
) -> tuple[dict[str, Any], str]:
    """Sync models from provider, building/updating the state file.

    Merge strategy (位置即语义):
    - editable 外 = provider 事实 (label/reasoning/context_window/cost/compat)
      → 每次 sync 以 provider.yaml 覆盖
    - editable 内 = 用户地盘 (max_tokens/enabled)
      → sync 绝不碰，新模型填默认值
    - status/error = 运行时状态
      → MODEL_DEPRECATED 等由 sync 自动标记
    """
    existing = load_state(name)
    existing_models = existing.get("models", {}) if existing else {}
    existing_source = existing.get("source") if existing else None
    existing_api_base = existing.get("api_base", api_base) if existing else api_base

    # Load provider definition (models whitelist)
    prov_def = load_provider_type(ptype) or {}
    prov_models = prov_def.get("models", {})

    try:
        live_ids = fetch_model_ids(api_base, api_key)
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500:
            raise RuntimeError(
                f"4xx from provider: HTTP {e.code} — check your API key and endpoint"
            ) from e
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
        raise RuntimeError(
            f"No model source for '{ptype}' — provider has no /v1/models and no provider.yaml models"
        )

    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    upstream_set = set(ids) if live_ids is not None else None
    models: dict[str, dict[str, Any]] = {}

    # Only expose models declared in provider.yaml (whitelist) when fetching live
    whitelist_ids = list(prov_models.keys()) if prov_models else ids
    for mid in whitelist_ids:
        prev = existing_models.get(mid, {})
        prev_editable = prev.get("editable", {})
        meta = prov_models.get(mid, {})

        # 兼容迁移：如果 prev 还有平铺的 enabled/max_tokens（旧格式），提取到 editable
        if not prev_editable and ("enabled" in prev or "max_tokens" in prev):
            prev_editable = {
                "max_tokens": prev.get("max_tokens", 4096),
                "enabled": prev.get("enabled", True),
            }

        # 运行时状态 — state 只存 editable/status/error，不进冗余的 provider 事实
        # label/context_window/reasoning/cost/compat 都在 provider.yaml 里，显示时从那里读
        model: dict[str, Any] = {
            "status": prev.get("status", "ok"),
            "error": prev.get("error"),
        }

        # User-editable 字段 — sync 绝不碰，只保留已有值或填默认
        model["editable"] = {
            "max_tokens": prev_editable.get("max_tokens", 4096),
            "enabled": prev_editable.get("enabled", True),
        }

        models[mid] = model

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

    state: dict[str, Any] = {
        "version": LOCK_VERSION,
        "updated_at": now,
        "provider": name,
        "provider_type": ptype,
        "models": models,
    }
    if existing_source:
        state["source"] = existing_source
        state["api_base"] = existing_api_base
    return state, label


def _is_enabled(m: dict[str, Any]) -> bool:
    """Check if model is enabled, supporting both old flat and new editable format."""
    editable = m.get("editable")
    if editable is not None:
        return bool(editable.get("enabled", False))
    return bool(m.get("enabled", False))


def get_enabled_models(name: str) -> dict[str, dict[str, Any]]:
    """Return enabled, non-stale, non-error models from state."""
    state = load_state(name)
    if not state:
        return {}
    models = state.get("models", {})
    return {
        mid: m
        for mid, m in models.items()
        if _is_enabled(m)
        and not m.get("stale")
        and m.get("status") not in ("error", "exhausted")
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
        mid
        for mid, m in models.items()
        if isinstance(m.get("error"), dict)
        and m["error"].get("code") == "MODEL_DEPRECATED"
    ]
    for mid in removed:
        del models[mid]
    save_state(name, state)
    return removed



