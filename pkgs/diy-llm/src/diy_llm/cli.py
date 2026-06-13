"""diy-llm CLI — credential management, model sync, local proxy.

Thin CLI layer on top of diy_llm.core and diy_llm.auth.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Annotated, Any
from importlib.metadata import version

import yaml
from cyclopts import App, Parameter

from diy_llm import core, auth


def _die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


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
    """Start LiteLLM proxy — reads state file, no API call needed."""
    types = core.discover_provider_types()

    if list_providers:
        if not types:
            _die("No bundled provider types.")
        auth_data = auth.load_auth()
        pool = auth_data.get("credential_pool", {})
        print("Available providers:")
        for tname in sorted(types):
            cred_count = len(pool.get(tname, []))
            state = core.load_state(tname)
            stale = sum(1 for m in (state or {}).get("models", {}).values() if m.get("stale"))
            live = sum(1 for m in (state or {}).get("models", {}).values() if m.get("enabled") and not m.get("stale"))
            state_status = f"{live} models" if state else "not synced"
            if stale:
                state_status += f" ({stale} stale)"
            cred_status = f"{cred_count} keys" if cred_count else "no auth"
            print(f"  {tname:30s}  [{cred_status}]  [{state_status}]")
        return

    name = provider or next(iter(types))

    cred = auth.get_active_credential(name)
    if not cred:
        _die(f"No credential for '{name}'. Run: diy-llm auth set {name} --key $ENV_VAR")

    api_key = auth.resolve_api_key(cred)
    if not api_key:
        _die(f"Cannot resolve API key for '{name}'. Check env var.")

    api_base = cred.get("api_base", "")

    enabled = core.get_enabled_models(name)
    if not enabled:
        _die(f"No enabled models for '{name}'. Edit {core.state_path(name)} to enable some.")

    # Build litellm config
    litellm_cfg = core.build_litellm_config(name, api_base, api_key, enabled)

    fd, config_path = tempfile.mkstemp(suffix=".yaml", prefix=f"diy-llm-{name}-")
    with os.fdopen(fd, "w") as f:
        yaml.dump(litellm_cfg, f, default_flow_style=False, sort_keys=False)

    state = core.load_state(name)
    ptype = (state or {}).get("provider_type", name)
    cfg = core.load_config()
    default = cfg.get("default_model", {}).get(name)

    print(f"🚀  diy-llm proxy  —  {name}  :{port}")
    print(f"    Type:   {ptype}")
    print(f"    Key:    {cred.get('label', '?')}  [{cred.get('last_status', 'ok')}]")
    if default:
        dm = enabled.get(default)
        dm_name = dm.get("label", default) if dm else default
        print(f"    Default: {default}  ({dm_name})")
    print(f"    Models: {len(enabled)} enabled")
    for i, (mid, meta) in enumerate(enabled.items(), 1):
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
    """Fetch models from provider, update state file. On error, keep old cache."""
    types = core.discover_provider_types()
    name = provider or next(iter(types))

    cred = auth.get_active_credential(name)
    if not cred:
        _die(f"No credential for '{name}'. Run: diy-llm auth set {name} --key $ENV_VAR")

    api_key = auth.resolve_api_key(cred)
    if not api_key:
        _die("Cannot resolve API key. Check env var.")

    api_base = cred.get("api_base", "")
    ptype = cred.get("provider_type", name)

    try:
        state, srcl = core.ensure_state(name, api_base, api_key, ptype)
        core.save_state(name, state)
        enabled = sum(1 for m in state["models"].values() if m.get("enabled") and not m.get("stale"))
        total = len(state["models"])
        print(f"✓  Sync ok ({srcl}): {enabled}/{total} enabled  →  {core.state_path(name)}")
    except RuntimeError as e:
        print(f"✗  Sync failed: {e}", file=sys.stderr)
        print("   Previous state file preserved.", file=sys.stderr)
        sys.exit(1)


# ── auth group ────────────────────────────────────────────────────────

auth_app = App(name="auth", help="Manage credentials")


@auth_app.command(name="set")
def set_cred(
    provider_type: Annotated[str, Parameter(help="Provider type (e.g. tencent-tokenhub)")],
    key: Annotated[str, Parameter(help="API key value or $ENV_VAR")],
    name: Annotated[str | None, Parameter(help="Instance name, default: same as type")] = None,
    base_url: Annotated[str | None, Parameter(help="Override default api_base")] = None,
    label: Annotated[str | None, Parameter(help="Human-friendly label")] = None,
    priority: Annotated[int, Parameter(help="Priority, lower = higher")] = 0,
):
    """Register a credential (idempotent) and sync models immediately."""
    ptype_name = provider_type
    instance_name = name or ptype_name

    ptype = core.load_provider_type(ptype_name)
    if not ptype:
        available = ", ".join(sorted(core.discover_provider_types()))
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
        core.ensure_dirs()
        (core.DIYM_HOME / ".env").write_text(f"{env_name}={actual_key}\n")
        os.environ[env_name] = actual_key
        label_resolved = label or env_name

    fp = auth.fingerprint(actual_key)

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

    auth_data = auth.load_auth()
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
    auth.save_auth(auth_data)

    print(f"✓  Credential set for '{instance_name}'")
    print(f"   type:   {ptype_name}")
    print(f"   label:  {label_resolved}")
    print(f"   source: {source}")
    print(f"   base:   {base_url_resolved}")

    print()
    try:
        state, srcl = core.ensure_state(instance_name, base_url_resolved, actual_key, ptype_name)
        core.save_state(instance_name, state)
        enabled = sum(1 for m in state["models"].values() if m.get("enabled") and not m.get("stale"))
        print(f"✓  Initial sync ({srcl}): {enabled} models enabled")
    except RuntimeError as e:
        print(f"⚠  Sync failed: {e}", file=sys.stderr)
        print(f"   Credential saved. Run 'diy-llm sync {instance_name}' when ready.", file=sys.stderr)


@auth_app.command(name="list")
def list_cred():
    """List all credentials."""
    auth_data = auth.load_auth()
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
    auth_data = auth.load_auth()
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
    state = core.load_state(provider)
    if not state:
        _die(f"No state for '{provider}'. Run: diy-llm sync {provider} first.")

    models = state.get("models", {})
    if model_id not in models:
        available = ", ".join(sorted(models.keys()))
        _die(f"Model '{model_id}' not found in state for '{provider}'. Available: {available}")

    if models[model_id].get("stale"):
        print(f"⚠  Warning: '{model_id}' is marked stale (no longer in provider's model list).", file=sys.stderr)

    cfg = core.load_config()
    cfg.setdefault("default_model", {})[provider] = model_id
    core.save_config(cfg)

    meta = models[model_id]
    print(f"✓  Default model for '{provider}' set to:")
    print(f"     {model_id}  ({meta.get('label', model_id)})")


@model_app.command(name="show")
def show_model(
    provider: Annotated[str | None, Parameter(help="Provider instance name", negative=False)] = None,
):
    """Show current default model for a provider or all."""
    cfg = core.load_config()
    defaults = cfg.get("default_model", {})

    if provider:
        mid = defaults.get(provider)
        if not mid:
            print(f"No default model set for '{provider}'.")
            return
        state = core.load_state(provider)
        meta = (state or {}).get("models", {}).get(mid, {})
        print(f"Default model for '{provider}':")
        print(f"  {mid}  ({meta.get('label', mid)})")
        return

    if not defaults:
        print("No default models configured.")
        return

    print("Default models:")
    for prov, mid in sorted(defaults.items()):
        state = core.load_state(prov)
        meta = (state or {}).get("models", {}).get(mid, {})
        stale = " (stale)" if meta.get("stale") else ""
        print(f"  {prov:30s}  {mid:35s}{stale}")


@model_app.command(name="unset")
def unset_model(
    provider: Annotated[str | None, Parameter(help="Provider instance name", negative=False)] = None,
):
    """Clear default model for a provider, or all if no provider given."""
    cfg = core.load_config()
    defaults = cfg.get("default_model", {})

    if provider:
        if provider not in defaults:
            print(f"No default model set for '{provider}'.")
            return
        del defaults[provider]
        core.save_config(cfg)
        print(f"✓  Default model cleared for '{provider}'.")
    else:
        if not defaults:
            print("No default models configured.")
            return
        count = len(defaults)
        cfg["default_model"] = {}
        core.save_config(cfg)
        print(f"✓  All {count} default model(s) cleared.")


@model_app.command(name="exclude")
def exclude_model(
    provider: Annotated[str, Parameter(help="Provider instance name")],
    model_id: Annotated[str, Parameter(help="Model ID to exclude")],
):
    """Disable a model — mark as exclude in config and state."""
    state = core.load_state(provider)
    models = (state or {}).get("models", {})
    if model_id not in models:
        available = ", ".join(sorted(models.keys())) if models else "(not synced)"
        _die(f"Model '{model_id}' not found in state for '{provider}'. Available: {available}")

    if models[model_id].get("stale"):
        print(f"⚠  Model '{model_id}' is already stale (no longer on provider).", file=sys.stderr)

    cfg = core.load_config()
    excludes = cfg.setdefault("exclude_models", {}).setdefault(provider, [])
    if model_id not in excludes:
        excludes.append(model_id)
    core.save_config(cfg)

    # Also update state immediately
    models[model_id]["enabled"] = False
    core.save_state(provider, state)

    print(f"✓  Model '{model_id}' excluded for '{provider}'.")


@model_app.command(name="include")
def include_model(
    provider: Annotated[str, Parameter(help="Provider instance name")],
    model_id: Annotated[str | None, Parameter(help="Model ID to include back, or omit to list excludes", negative=False)] = None,
):
    """Re-enable a model — remove from exclude list."""
    state = core.load_state(provider)
    if not state:
        _die(f"No state for '{provider}'. Run sync first.")

    cfg = core.load_config()
    excludes = cfg.setdefault("exclude_models", {}).get(provider, [])

    if model_id is None:
        models = state.get("models", {})
        if not excludes:
            print(f"No models excluded for '{provider}'.")
            return
        print(f"Excluded models for '{provider}':")
        for mid in sorted(excludes):
            meta = models.get(mid, {})
            label = f" ({meta.get('label', mid)})" if meta.get("label") else ""
            print(f"  - {mid}{label}")
        return

    if model_id not in excludes:
        _die(f"Model '{model_id}' is not excluded for '{provider}'. Use 'model exclude' first.")

    excludes.remove(model_id)
    if not excludes:
        del cfg["exclude_models"][provider]
    core.save_config(cfg)

    # Update state
    models = state.get("models", {})
    if model_id in models:
        models[model_id]["enabled"] = True
    core.save_state(provider, state)

    print(f"✓  Model '{model_id}' included back for '{provider}'.")


# Register sub-apps
app.command(model_app)


# ── entry point ───────────────────────────────────────────────────────

def main() -> None:
    auth.load_dotenv()
    app(sys.argv[1:] if len(sys.argv) > 1 else ["--help"])


if __name__ == "__main__":
    main()
