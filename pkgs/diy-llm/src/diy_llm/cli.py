"""diy-llm CLI — credential management, model sync, local proxy.

Architecture:
  provider type         bundled descriptor (auth scheme, default api_base, models)
  diy-llm auth set     → register credential + initial sync
  diy-llm sync         → fetch models → update lock file (failure keeps old cache)
  diy-llm serve        → read lock → start litellm proxy (no API dependency)
  diy-llm model set    → set default model for a provider

  lock file: stable data source for serve, updated only by explicit sync or bg refresh.
  sync failures (4xx=us, 5xx=provider) preserve the last known good cache.

Credentials:
  ~/.diy-llm/auth.json  credential pool (Hermes-style, fingerprint + status)

Usage:
  diy-llm auth set qcloud-tokenhub --key '$ENV_VAR'
  diy-llm sync qcloud-tokenhub
  diy-llm serve qcloud-tokenhub --port 18888
  diy-llm model set qcloud-tokenhub deepseek-v4-flash
"""

from __future__ import annotations

import hashlib
import importlib.resources
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Annotated, Any
from importlib.metadata import version

import yaml
from cyclopts import App, Parameter

# ── paths ─────────────────────────────────────────────────────────────

DIYM_HOME = Path.home() / ".diy-llm"
AUTH_FILE = DIYM_HOME / "auth.json"
CONFIG_FILE = DIYM_HOME / "config.json"
LOCKS_DIR = DIYM_HOME / "locks"


def _ensure_dirs() -> None:
    LOCKS_DIR.mkdir(parents=True, exist_ok=True)


# ── provider type registry ────────────────────────────────────────────

def _discover_provider_types() -> dict[str, Path]:
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
        type_file = Path(str(entry)) / "type.yaml"
        if type_file.is_file():
            result[entry.name] = type_file
    return result


def _load_provider_type(ptype: str) -> dict[str, Any] | None:
    types = _discover_provider_types()
    path = types.get(ptype)
    if not path:
        return None
    with open(path) as f:
        return yaml.safe_load(f)


def _defaults_path(ptype: str) -> Path | None:
    types = _discover_provider_types()
    type_path = types.get(ptype)
    if not type_path:
        return None
    defaults = type_path.parent / "models.defaults.json"
    return defaults if defaults.is_file() else None


# ── config.json (default-model etc.) ──────────────────────────────────

def _load_config() -> dict[str, Any]:
    if CONFIG_FILE.is_file():
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return {"version": 1, "default_model": {}}


def _save_config(cfg: dict[str, Any]) -> None:
    _ensure_dirs()
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ── auth.json ─────────────────────────────────────────────────────────

def _load_auth() -> dict[str, Any]:
    if AUTH_FILE.is_file():
        with open(AUTH_FILE) as f:
            return json.load(f)
    return {"version": 1, "credential_pool": {}}


def _save_auth(auth: dict[str, Any]) -> None:
    _ensure_dirs()
    with open(AUTH_FILE, "w") as f:
        json.dump(auth, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()[:16]


# ── lock file ─────────────────────────────────────────────────────────

LOCK_VERSION = 1


def _lock_path(provider_name: str) -> Path:
    return LOCKS_DIR / f"{provider_name}.lock.json"


def _load_lock(provider_name: str) -> dict[str, Any] | None:
    path = _lock_path(provider_name)
    if not path.is_file():
        return None
    with open(path) as f:
        return json.load(f)


def _save_lock(provider_name: str, lock: dict[str, Any]) -> None:
    _ensure_dirs()
    with open(_lock_path(provider_name), "w") as f:
        json.dump(lock, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ── model sync logic ─────────────────────────────────────────────────


def _fetch_model_ids(api_base: str, api_key: str) -> list[str] | None:
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


def _ensure_lock(name: str, api_base: str, api_key: str, ptype: str) -> tuple[dict[str, Any], str]:
    """Build a lock file entry."""
    existing = _load_lock(name)
    existing_models = existing.get("models", {}) if existing else {}

    try:
        live_ids = _fetch_model_ids(api_base, api_key)
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500:
            raise RuntimeError(f"4xx from provider: HTTP {e.code} — check your API key and endpoint") from e
        raise RuntimeError(f"5xx from provider: HTTP {e.code} — provider error") from e
    except Exception as e:
        raise RuntimeError(f"Network error: {e}") from e

    if live_ids is not None:
        ids = live_ids
        label = "live /v1/models"
    else:
        defaults = _defaults_path(ptype)
        if defaults and defaults.is_file():
            with open(defaults) as f:
                fallback = json.load(f)
            ids = list(fallback.get("models", {}).keys())
            label = "bundled defaults"
        elif existing_models:
            ids = list(existing_models.keys())
            label = "cached (no /v1/models)"
        else:
            raise RuntimeError(f"No model source for '{ptype}' — provider has no /v1/models and no defaults bundled")

    meta_defaults = {}
    defaults = _defaults_path(ptype)
    if defaults and defaults.is_file():
        with open(defaults) as f:
            meta_defaults = json.load(f).get("models", {})

    models: dict[str, dict[str, Any]] = {}
    for mid in ids:
        prev = existing_models.get(mid, {})
        meta = meta_defaults.get(mid, {})
        models[mid] = {
            "id": mid,
            "name": prev.get("name", meta.get("name", mid)),
            "enabled": prev.get("enabled", True),
            "context_window": prev.get("context_window", meta.get("context_window", 128000)),
            "max_tokens": prev.get("max_tokens", meta.get("max_tokens", 4096)),
            "reasoning": prev.get("reasoning", meta.get("reasoning", False)),
            "cost": prev.get("cost", meta.get("cost", {"input": 0, "output": 0})),
            "compat": prev.get("compat", meta.get("compat", {})),
            "status": prev.get("status", "ok"),
            "error_last_code": prev.get("error_last_code"),
            "error_last_message": prev.get("error_last_message"),
            "error_last_time": prev.get("error_last_time"),
            "error_retry_times": prev.get("error_retry_times", 0),
            "error_retry_after": prev.get("error_retry_after"),
        }

    for mid, prev in existing_models.items():
        if mid not in models:
            models[mid] = {**prev, "stale": True}

    lock = {
        "version": LOCK_VERSION,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "provider": name,
        "provider_type": ptype,
        "models": models,
    }
    return lock, label


# ── helpers ───────────────────────────────────────────────────────────

def _die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def _resolve_api_key(cred: dict[str, Any]) -> str | None:
    source = cred.get("source", "")
    if source.startswith("env:"):
        return os.environ.get(source[4:])


def _get_active_credential(name: str) -> dict[str, Any] | None:
    auth = _load_auth()
    pool = auth.get("credential_pool", {}).get(name, [])
    if not pool:
        return None
    ok = [c for c in pool if c.get("last_status") == "ok"]
    candidates = ok if ok else pool
    candidates.sort(key=lambda c: c.get("priority", 999))
    return candidates[0] if candidates else pool[0]


# ═══════════════════════════════════════════════════════════════════════
# Cyclopts App
# ═══════════════════════════════════════════════════════════════════════

app = App(
    name="diy-llm",
    help="Local LLM proxy — multi-provider AI gateway via LiteLLM",
    version=version("diy-llm") if __package__ else "0.1.0",
    version_flags=["--version"],
)


# ── serve ─────────────────────────────────────────────────────────────

@app.command
def serve(
    provider: Annotated[str | None, Parameter(help="Provider instance name", negative=False)] = None,
    port: Annotated[int, Parameter(help="Listen port")] = 18888,
    list_providers: Annotated[bool, Parameter(name="--list-providers", help="Show provider status table")] = False,
):
    """Start LiteLLM proxy — reads lock file, no API call needed."""
    types = _discover_provider_types()

    if list_providers:
        if not types:
            _die("No bundled provider types.")
        auth_data = _load_auth()
        pool = auth_data.get("credential_pool", {})
        print("Available providers:")
        for tname in sorted(types):
            cred_count = len(pool.get(tname, []))
            lock = _load_lock(tname)
            stale = sum(1 for m in (lock or {}).get("models", {}).values() if m.get("stale"))
            live = sum(1 for m in (lock or {}).get("models", {}).values() if m.get("enabled") and not m.get("stale"))
            lock_status = f"{live} models" if lock else "not synced"
            if stale:
                lock_status += f" ({stale} stale)"
            cred_status = f"{cred_count} keys" if cred_count else "no auth"
            print(f"  {tname:30s}  [{cred_status}]  [{lock_status}]")
        return

    name = provider or next(iter(types))

    cred = _get_active_credential(name)
    if not cred:
        _die(f"No credential for '{name}'. Run: diy-llm auth set {name} --key $ENV_VAR")

    api_key = _resolve_api_key(cred)
    if not api_key:
        _die(f"Cannot resolve API key for '{name}'. Check env var.")

    api_base = cred.get("api_base", "")

    lock = _load_lock(name)
    if not lock:
        _die(f"No lock for '{name}'. Run: diy-llm sync {name}")

    models = lock.get("models", {})
    enabled = {mid: m for mid, m in models.items() if m.get("enabled") and not m.get("stale")}
    if not enabled:
        _die(f"No enabled models for '{name}'. Edit {_lock_path(name)} to enable some.")

    # Build litellm config
    model_list = []
    for mid, mdef in enabled.items():
        model_list.append({
            "model_name": f"{name}/{mid}",
            "litellm_params": {
                "model": f"custom_openai/{mid}",
                "api_base": api_base,
                "api_key": api_key,
            },
        })

    litellm_cfg = {
        "model_list": model_list,
        "litellm_settings": {"drop_params": True, "set_verbose": False},
        "general_settings": {},
    }

    fd, config_path = tempfile.mkstemp(suffix=".yaml", prefix=f"diy-llm-{name}-")
    with os.fdopen(fd, "w") as f:
        yaml.dump(litellm_cfg, f, default_flow_style=False, sort_keys=False)

    ptype = lock.get("provider_type", name)
    cfg = _load_config()
    default = cfg.get("default_model", {}).get(name)

    print(f"🚀  diy-llm proxy  —  {name}  :{port}")
    print(f"    Type:   {ptype}")
    print(f"    Key:    {cred.get('label', '?')}  [{cred.get('last_status', 'ok')}]")
    if default:
        dm = enabled.get(default)
        dm_name = dm.get("name", default) if dm else default
        print(f"    Default: {default}  ({dm_name})")
    print(f"    Models: {len(model_list)} enabled")
    for i, m in enumerate(model_list, 1):
        mid = m["model_name"].split("/", 1)[1]
        meta = enabled.get(mid, {})
        ctx = meta.get("context_window", "?")
        status = meta.get("status", "ok")
        status_icon = {"ok": "✓", "error": "✗", "exhausted": "⚠"}.get(status, "?")
        retries = meta.get("error_retry_times", 0)
        retry_str = f" x{retries}" if retries else ""
        cost = meta.get("cost", {})
        ci, co = cost.get("input", 0), cost.get("output", 0)
        cost_str = f"${ci}i/${co}o" if ci or co else ""
        r = "🧠" if meta.get("reasoning") else ""
        mark = " ← default" if mid == default else ""
        print(f"      {i}. {mid:35s}  [{status_icon} {status}{retry_str}]  ctx={ctx:<8}  {cost_str:15s}  {r}{mark}")
    print(f"    Config: {config_path}")
    print()
    sys.stdout.flush()

    litellm_bin = os.path.join(os.path.dirname(sys.executable), "litellm")
    os.execvp(litellm_bin, [litellm_bin, "--config", config_path, "--port", str(port)])


# ── sync ──────────────────────────────────────────────────────────────

@app.command
def sync(
    provider: Annotated[str | None, Parameter(help="Provider instance name", negative=False)] = None,
):
    """Fetch models from provider, update lock file. On error, keep old cache."""
    types = _discover_provider_types()
    name = provider or next(iter(types))

    cred = _get_active_credential(name)
    if not cred:
        _die(f"No credential for '{name}'. Run: diy-llm auth set {name} --key $ENV_VAR")

    api_key = _resolve_api_key(cred)
    if not api_key:
        _die("Cannot resolve API key. Check env var.")

    api_base = cred.get("api_base", "")
    ptype = cred.get("provider_type", name)

    try:
        lock, srcl = _ensure_lock(name, api_base, api_key, ptype)
        _save_lock(name, lock)
        enabled = sum(1 for m in lock["models"].values() if m.get("enabled") and not m.get("stale"))
        total = len(lock["models"])
        print(f"✓  Sync ok ({srcl}): {enabled}/{total} enabled  →  {_lock_path(name)}")
    except RuntimeError as e:
        print(f"✗  Sync failed: {e}", file=sys.stderr)
        print("   Previous lock file preserved.", file=sys.stderr)
        sys.exit(1)


# ── auth group ────────────────────────────────────────────────────────

auth_app = App(name="auth", help="Manage credentials")


@auth_app.command(name="set")
def set_cred(
    provider_type: Annotated[str, Parameter(help="Provider type (e.g. qcloud-tokenhub)")],
    key: Annotated[str, Parameter(help="API key value or $ENV_VAR")],
    name: Annotated[str | None, Parameter(help="Instance name, default: same as type")] = None,
    base_url: Annotated[str | None, Parameter(help="Override default api_base")] = None,
    label: Annotated[str | None, Parameter(help="Human-friendly label")] = None,
    priority: Annotated[int, Parameter(help="Priority, lower = higher")] = 0,
):
    """Register a credential (idempotent) and sync models immediately."""
    ptype_name = provider_type
    instance_name = name or ptype_name

    ptype = _load_provider_type(ptype_name)
    if not ptype:
        available = ", ".join(sorted(_discover_provider_types()))
        _die(f"Unknown provider type '{ptype_name}'. Available: {available}")

    base_url_resolved = base_url or ptype.get("api", {}).get("default_base", "")
    auth_scheme = ptype.get("auth", {}).get("scheme", "api_key")

    if not key:
        _die(f"Missing --key. Usage: diy-llm auth set {ptype_name} --key $ENV_VAR")

    if key.startswith("$"):
        env_name = key[1:]
        source = f"env:{env_name}"
        actual_key = os.environ.get(env_name, "")
        if not actual_key:
            _die(f"Environment variable {env_name} is not set")
        label_resolved = label or env_name
    else:
        env_name = label or f"DIY_{ptype_name.upper().replace('-','_')}_KEY"
        source = f"env:{env_name}"
        actual_key = key
        _ensure_dirs()
        (DIYM_HOME / ".env").write_text(f"{env_name}={actual_key}\n")
        os.environ[env_name] = actual_key
        label_resolved = label or env_name

    fp = _fingerprint(actual_key)

    cred: dict[str, Any] = {
        "id": fp[:6],
        "label": label_resolved,
        "auth_type": auth_scheme,
        "priority": priority,
        "source": source,
        "api_base": base_url_resolved,
        "provider_type": ptype_name,
        "request_count": 0,
        "secret_fingerprint": fp,
    }

    auth_data = _load_auth()
    pool = auth_data.setdefault("credential_pool", {}).setdefault(instance_name, [])
    replaced = False
    for i, existing in enumerate(pool):
        if existing.get("label") == cred["label"]:
            if existing.get("secret_fingerprint") == fp:
                cred["last_status"] = existing.get("last_status", "ok")
                cred["last_error_code"] = existing.get("last_error_code")
                cred["last_error_reason"] = existing.get("last_error_reason")
                cred["last_error_reset_at"] = existing.get("last_error_reset_at")
                cred["request_count"] = existing.get("request_count", 0)
            pool[i] = cred
            replaced = True
            break
    if not replaced:
        pool.append(cred)
    cred["last_status"] = cred.get("last_status", "ok")
    _save_auth(auth_data)

    print(f"✓  Credential set for '{instance_name}'")
    print(f"   type:   {ptype_name}")
    print(f"   label:  {label_resolved}")
    print(f"   source: {source}")
    print(f"   base:   {base_url_resolved}")

    print()
    try:
        lock, srcl = _ensure_lock(instance_name, base_url_resolved, actual_key, ptype_name)
        _save_lock(instance_name, lock)
        enabled = sum(1 for m in lock["models"].values() if m.get("enabled") and not m.get("stale"))
        print(f"✓  Initial sync ({srcl}): {enabled} models enabled")
    except RuntimeError as e:
        print(f"⚠  Sync failed: {e}", file=sys.stderr)
        print(f"   Credential saved. Run 'diy-llm sync {instance_name}' when ready.", file=sys.stderr)


@auth_app.command(name="list")
def list_cred():
    """List all credentials."""
    auth_data = _load_auth()
    pool = auth_data.get("credential_pool", {})
    if not pool:
        print("No credentials. Use: diy-llm auth set ...")
        return
    for instance_name, creds in pool.items():
        print(f"\n{instance_name}")
        for c in creds:
            status = c.get("last_status", "?")
            icon = {"ok": "✓", "exhausted": "⚠", "error": "✗"}.get(status, "?")
            print(f"  {icon} {c['label']:25s}  {status:10s}  fp={c.get('secret_fingerprint', '')[:14]}")


@auth_app.command(name="show")
def show_cred(
    provider: Annotated[str, Parameter(help="Provider instance name")],
):
    """Show credential details."""
    auth_data = _load_auth()
    pool = auth_data.get("credential_pool", {}).get(provider, [])
    if not pool:
        _die(f"No credentials for '{provider}'")
    for c in pool:
        print(json.dumps(c, indent=2, ensure_ascii=False))
        print()


# Register sub-apps
app.command(auth_app)

# ── model group ───────────────────────────────────────────────────────

model_app = App(name="model", help="Manage default model per provider")


@model_app.command(name="set")
def set_model(
    provider: Annotated[str, Parameter(help="Provider instance name")],
    model_id: Annotated[str, Parameter(help="Model ID (e.g. deepseek-v4-flash)")],
):
    """Set default model for a provider."""
    lock = _load_lock(provider)
    if not lock:
        _die(f"No lock for '{provider}'. Run: diy-llm sync {provider} first.")

    models = lock.get("models", {})
    if model_id not in models:
        available = ", ".join(sorted(models.keys()))
        _die(f"Model '{model_id}' not found in lock for '{provider}'. Available: {available}")

    if models[model_id].get("stale"):
        print(f"⚠  Warning: '{model_id}' is marked stale (no longer in provider's model list).", file=sys.stderr)

    cfg = _load_config()
    cfg.setdefault("default_model", {})[provider] = model_id
    _save_config(cfg)

    meta = models[model_id]
    print(f"✓  Default model for '{provider}' set to:")
    print(f"     {model_id}  ({meta.get('name', model_id)})")


@model_app.command(name="show")
def show_model(
    provider: Annotated[str | None, Parameter(help="Provider instance name", negative=False)] = None,
):
    """Show current default model for a provider or all."""
    cfg = _load_config()
    defaults = cfg.get("default_model", {})

    if provider:
        mid = defaults.get(provider)
        if not mid:
            print(f"No default model set for '{provider}'.")
            return
        lock = _load_lock(provider)
        meta = (lock or {}).get("models", {}).get(mid, {})
        print(f"Default model for '{provider}':")
        print(f"  {mid}  ({meta.get('name', mid)})")
        return

    if not defaults:
        print("No default models configured.")
        return

    print("Default models:")
    for prov, mid in sorted(defaults.items()):
        lock = _load_lock(prov)
        meta = (lock or {}).get("models", {}).get(mid, {})
        stale = " (stale)" if meta.get("stale") else ""
        print(f"  {prov:30s}  {mid:35s}{stale}")


@model_app.command(name="unset")
def unset_model(
    provider: Annotated[str | None, Parameter(help="Provider instance name", negative=False)] = None,
):
    """Clear default model for a provider, or all if no provider given."""
    cfg = _load_config()
    defaults = cfg.get("default_model", {})

    if provider:
        if provider not in defaults:
            print(f"No default model set for '{provider}'.")
            return
        del defaults[provider]
        _save_config(cfg)
        print(f"✓  Default model cleared for '{provider}'.")
    else:
        if not defaults:
            print("No default models configured.")
            return
        count = len(defaults)
        cfg["default_model"] = {}
        _save_config(cfg)
        print(f"✓  All {count} default model(s) cleared.")


# Register sub-apps
app.command(model_app)


# ── entry point ───────────────────────────────────────────────────────

def main() -> None:
    app(sys.argv[1:] if len(sys.argv) > 1 else ["--help"])


if __name__ == "__main__":
    main()
