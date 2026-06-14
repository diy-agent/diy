"""diy-llm CLI — credential management, model sync, local proxy.

Thin CLI layer on top of diy_llm.core and diy_llm.auth.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from typing import Annotated, Any
from importlib.metadata import version

import yaml
from cyclopts import App, Group, Parameter

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
    provider: Annotated[str | None, Parameter(help="Provider name; omit for all configured", negative=False)] = None,
    port: Annotated[int, Parameter(help="Listen port")] = 18888,
    list_providers: Annotated[bool, Parameter(name="--list-providers", help="Show provider status table")] = False,
):
    """Start LiteLLM proxy — serve all configured providers by default."""
    types = core.discover_provider_types()

    if list_providers:
        if not types:
            _die("No bundled provider types.")
        auth_data = auth.load_auth()
        providers = auth_data.get("providers", {})
        print("Available providers:")
        for tname in sorted(types):
            cred_status = "has auth" if tname in providers else "no auth"
            state = core.load_state(tname)
            stale = sum(1 for m in (state or {}).get("models", {}).values() if m.get("stale"))
            live = sum(1 for m in (state or {}).get("models", {}).values() if m.get("enabled") and not m.get("stale"))
            state_status = f"{live} models" if state else "not synced"
            if stale:
                state_status += f" ({stale} stale)"
            print(f"  {tname:30s}  [{cred_status}]  [{state_status}]")
        return

    # Resolve which providers to serve
    if provider:
        target_names = [provider]
    else:
        auth_data = auth.load_auth()
        target_names = [t for t in types if t in auth_data.get("providers", {})]
        if not target_names:
            _die("No providers with credentials. Run: diy-llm auth set <provider> --key $ENV_VAR")

    # Build combined config
    models_by_provider: dict[str, dict[str, Any]] = {}
    auth_data = auth.load_auth()
    for name in target_names:
        prov_auth = auth_data.get("providers", {}).get(name)
        if not prov_auth:
            continue

        api_key = auth.resolve_api_key(prov_auth["source"])
        if not api_key:
            print(f"⚠  Skipping {name}: cannot resolve {prov_auth['source']}", file=sys.stderr)
            continue

        api_base = prov_auth.get("api_base", "")
        if not api_base:
            ptype_def = core.load_provider_type(name)
            api_base = (ptype_def or {}).get("api", {}).get("default_base", "")

        enabled = core.get_enabled_models(name)
        if not enabled:
            print(f"⚠  Skipping {name}: no enabled models", file=sys.stderr)
            continue

        models_by_provider[name] = {"api_base": api_base, "api_key": api_key, "models": enabled}

    if not models_by_provider:
        _die("No providers ready to serve. Check credentials and enabled models.")

    litellm_cfg = core.build_litellm_config(models_by_provider)

    prov_label = ",".join(target_names) if not provider else provider
    fd, config_path = tempfile.mkstemp(suffix=".yaml", prefix=f"diy-llm-")
    with os.fdopen(fd, "w") as f:
        yaml.dump(litellm_cfg, f, default_flow_style=False, sort_keys=False)

    total_models = sum(len(pd["models"]) for pd in models_by_provider.values())
    print(f"🚀  diy-llm proxy  —  {prov_label}  :{port}")
    print(f"    Providers: {len(models_by_provider)}")
    print(f"    Models:    {total_models} total")
    for pname, pdef in models_by_provider.items():
        print(f"\n    [{pname}]")
        for mid in pdef["models"]:
            state = core.load_state(pname)
            meta = (state or {}).get("models", {}).get(mid, {})
            ctx = meta.get("context_window", "?")
            r = "🧠" if meta.get("reasoning") else ""
            print(f"      - {pname}/{mid:35s}  ctx={ctx:<8}  {r}")
    print(f"\n    Config: {config_path}")
    print()
    sys.stdout.flush()

    litellm_bin = os.path.join(os.path.dirname(sys.executable), "litellm")
    os.execvp(litellm_bin, [litellm_bin, "--config", config_path, "--port", str(port)])


# ── sync ──────────────────────────────────────────────────────────────

@app.command
def sync(
    provider: Annotated[str | None, Parameter(help="Provider name; omit for all configured", negative=False)] = None,
):
    """Fetch models from provider, update state file."""
    auth_data = auth.load_auth()

    if provider:
        target_names = [provider]
    else:
        target_names = [n for n in auth_data.get("providers", {})]

    if not target_names:
        _die("No providers with credentials. Run: diy-llm auth set <provider> --key $ENV_VAR")

    for name in target_names:
        prov_auth = auth_data.get("providers", {}).get(name)
        if not prov_auth:
            print(f"⚠  No credential for '{name}'", file=sys.stderr)
            continue

        api_key = auth.resolve_api_key(prov_auth["source"])
        if not api_key:
            print(f"⚠  Cannot resolve {prov_auth['source']} for '{name}'", file=sys.stderr)
            continue

        api_base = prov_auth.get("api_base", "")
        if not api_base:
            ptype_def = core.load_provider_type(name)
            api_base = (ptype_def or {}).get("api", {}).get("default_base", "")

        try:
            state, srcl = core.ensure_state(name, api_base, api_key, name)
            core.save_state(name, state)
            enabled = sum(1 for m in state["models"].values() if m.get("enabled") and not m.get("stale"))
            total = len(state["models"])
            print(f"✓  {name} ({srcl}): {enabled}/{total} enabled  →  {core.state_path(name)}")
        except RuntimeError as e:
            print(f"✗  {name}: {e}", file=sys.stderr)


# ── auth group ────────────────────────────────────────────────────────

auth_app = App(name="auth", help="Manage credentials")


@auth_app.command(name="set")
def set_cred(
    provider: Annotated[str, Parameter(help="Provider name (e.g. tencent-tokenhub)")],
    key: Annotated[str, Parameter(help="API key value or $ENV_VAR")],
    base_url: Annotated[str | None, Parameter(help="Override default api_base")] = None,
):
    """Register a credential (idempotent) and sync models immediately."""
    ptype_def = core.load_provider_type(provider)
    if not ptype_def:
        available = ", ".join(sorted(core.discover_provider_types()))
        _die(f"Unknown provider '{provider}'. Available: {available}")

    if not key:
        _die(f"Missing --key. Usage: diy-llm auth set {provider} --key $ENV_VAR")

    if key.startswith("$"):
        env_name = key[1:]
        source = f"env:{env_name}"
        actual_key = os.environ.get(env_name, "")
        if not actual_key:
            _die(f"Environment variable {env_name} is not set")
    else:
        env_name = f"{provider.upper().replace('-','_')}_KEY"
        source = f"env:{env_name}"
        actual_key = key
        core.ensure_dirs()
        (core.DIYM_HOME / ".env").write_text(f"{env_name}={actual_key}\n")
        os.environ[env_name] = actual_key

    prov_auth: dict[str, Any] = {"source": source}
    if base_url:
        prov_auth["api_base"] = base_url
    else:
        prov_auth["api_base"] = ptype_def.get("api", {}).get("default_base", "")

    auth_data = auth.load_auth()
    auth_data.setdefault("providers", {})[provider] = prov_auth
    auth.save_auth(auth_data)

    print(f"✓  Credential set for '{provider}'")
    print(f"   source:  {source}")
    print(f"   base:    {prov_auth['api_base']}")

    print()
    try:
        state, srcl = core.ensure_state(provider, prov_auth["api_base"], actual_key, provider)
        core.save_state(provider, state)
        enabled = sum(1 for m in state["models"].values() if m.get("enabled") and not m.get("stale"))
        print(f"✓  Initial sync ({srcl}): {enabled} models enabled")
    except RuntimeError as e:
        print(f"⚠  Sync failed: {e}", file=sys.stderr)
        print(f"   Credential saved. Run 'diy-llm sync {provider}' when ready.", file=sys.stderr)


@auth_app.command(name="list")
def list_cred():
    """List all credentials."""
    auth_data = auth.load_auth()
    providers = auth_data.get("providers", {})
    if not providers:
        print("No credentials. Use: diy-llm auth set ...")
        return
    for pname, pauth in providers.items():
        api_base = pauth.get("api_base", "?")
        print(f"  {pname:30s}  {pauth['source']}  →  {api_base}")


@auth_app.command(name="show")
def show_cred(
    provider: Annotated[str, Parameter(help="Provider name")],
):
    """Show credential details."""
    auth_data = auth.load_auth()
    prov_auth = auth_data.get("providers", {}).get(provider)
    if not prov_auth:
        _die(f"No credential for '{provider}'")
    print(json.dumps(prov_auth, indent=2, ensure_ascii=False))


@auth_app.command(name="remove")
def remove_cred(
    provider: Annotated[str, Parameter(help="Provider name")],
):
    """Remove a credential."""
    auth_data = auth.load_auth()
    if provider not in auth_data.get("providers", {}):
        _die(f"No credential for '{provider}'")
    del auth_data["providers"][provider]
    auth.save_auth(auth_data)
    print(f"✓  Credential removed for '{provider}'.")


# Register sub-apps
app.command(auth_app)


# ── model group ───────────────────────────────────────────────────────

model_app = App(name="model", help="Manage models per provider")


@model_app.command(name="list")
def list_models(
    provider: Annotated[str | None, Parameter(help="Provider name; omit for all", negative=False)] = None,
):
    """List models and their status."""
    if provider:
        models = core.list_models(provider)
        if not models:
            print(f"No models for '{provider}'. Run sync first.")
            return
        print(f"Models for {provider}:")
        for mid, m in sorted(models.items()):
            _print_model(mid, m)
        return

    auth_data = auth.load_auth()
    for pname in sorted(auth_data.get("providers", {})):
        models = core.list_models(pname)
        if not models:
            continue
        print(f"\n[{pname}]")
        for mid, m in sorted(models.items()):
            _print_model(mid, m)


def _print_model(mid: str, m: dict[str, Any]) -> None:
    status = m.get("status", "ok")
    stale = " (stale)" if m.get("stale") else ""
    error = m.get("error")
    if isinstance(error, dict) and error.get("code") == "MODEL_DEPRECATED":
        status_str = "⚠ 废弃"
    elif status == "error":
        status_str = "✗ error"
    elif status == "exhausted":
        status_str = "⚠ exhausted"
    elif m.get("enabled"):
        status_str = "✓"
    else:
        status_str = "✗ disabled"
    label = m.get("label", mid)
    print(f"  {status_str}  {mid:35s}  {label}{stale}")


@model_app.command(name="clean")
def clean_models(
    provider: Annotated[str | None, Parameter(help="Provider name; omit for all", negative=False)] = None,
):
    """Remove MODEL_DEPRECATED models from state."""
    auth_data = auth.load_auth()
    target_names = [provider] if provider else list(auth_data.get("providers", {}))

    for name in target_names:
        removed = core.clean_models(name)
        if removed:
            print(f"✓  {name}: removed {len(removed)} deprecated model(s): {', '.join(removed)}")
        else:
            print(f"   {name}: no deprecated models")


# Register sub-apps
app.command(model_app)


# ── entry point ───────────────────────────────────────────────────────

def main() -> None:
    auth.load_dotenv()
    app(sys.argv[1:] if len(sys.argv) > 1 else ["--help"])


if __name__ == "__main__":
    main()
