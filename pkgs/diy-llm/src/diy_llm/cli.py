"""diy-llm CLI — credential management, model sync, local proxy.

Thin CLI layer on top of diy_llm.core and diy_llm.auth.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from typing import Annotated
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

    name = provider or next(iter(types))

    auth_data = auth.load_auth()
    prov_auth = auth_data.get("providers", {}).get(name)
    if not prov_auth:
        _die(f"No credential for '{name}'. Run: diy-llm auth set {name} --key $ENV_VAR")

    api_key = auth.resolve_api_key(prov_auth["source"])
    if not api_key:
        _die(f"Cannot resolve API key for '{name}'. Check env var {prov_auth['source']}")

    api_base = prov_auth.get("api_base", "")
    if not api_base:
        ptype_def = core.load_provider_type(name)
        api_base = (ptype_def or {}).get("api", {}).get("default_base", "")

    enabled = core.get_enabled_models(name)
    if not enabled:
        _die(f"No enabled models for '{name}'. Edit {core.state_path(name)} to enable some.")

    litellm_cfg = core.build_litellm_config({name: {"api_base": api_base, "api_key": api_key, "models": enabled}})

    fd, config_path = tempfile.mkstemp(suffix=".yaml", prefix=f"diy-llm-{name}-")
    with os.fdopen(fd, "w") as f:
        yaml.dump(litellm_cfg, f, default_flow_style=False, sort_keys=False)

    state = core.load_state(name)
    ptype = (state or {}).get("provider_type", name)

    print(f"🚀  diy-llm proxy  —  {name}  :{port}")
    print(f"    Type:   {ptype}")
    print(f"    Key:    {prov_auth['source']}")
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
        print(f"      {i}. {mid:35s}  [{status_icon} {status}{retry_str}]  ctx={ctx:<8}  {cost_str:15s}  {r}")
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

    auth_data = auth.load_auth()
    prov_auth = auth_data.get("providers", {}).get(name)
    if not prov_auth:
        _die(f"No credential for '{name}'. Run: diy-llm auth set {name} --key $ENV_VAR")

    api_key = auth.resolve_api_key(prov_auth["source"])
    if not api_key:
        _die(f"Cannot resolve API key for '{name}'. Check env var {prov_auth['source']}")

    api_base = prov_auth.get("api_base", "")
    if not api_base:
        ptype_def = core.load_provider_type(name)
        api_base = (ptype_def or {}).get("api", {}).get("default_base", "")
    ptype = name

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


# ── entry point ───────────────────────────────────────────────────────

def main() -> None:
    auth.load_dotenv()
    app(sys.argv[1:] if len(sys.argv) > 1 else ["--help"])


if __name__ == "__main__":
    main()
